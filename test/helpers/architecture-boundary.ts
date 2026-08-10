import { readdirSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

const SOURCE_FILE_RE = /\.[cm]?[jt]sx?$/;

export type ModuleLoad = {
  readonly line: number;
  readonly specifier: string | undefined;
};

export type ControlFlagAccess = {
  readonly flag: string;
  readonly line: number;
};

type StateAliasKind = "state" | "control";

const CONTROL_FLAGS = new Set([
  "quitting",
  "paused",
  "skipRequested",
  "restartRequested",
  "restartReason",
  "stopAfterIteration",
]);

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

export function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(abs));
    else if (SOURCE_FILE_RE.test(entry.name)) files.push(abs);
  }
  return files.sort();
}

function staticString(expression: ts.Expression): string | undefined {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped !== expression) return staticString(unwrapped);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(expression.left);
    const right = staticString(expression.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function propertyName(node: ts.PropertyName | ts.Expression): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}

function memberName(expression: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  return ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : expression.argumentExpression === undefined
      ? undefined
      : propertyName(expression.argumentExpression);
}

export function findModuleLoads(source: string, fileName: string): ModuleLoad[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const loads: ModuleLoad[] = [];
  const requireAliases = new Set(["require"]);
  const moduleAliases = new Set(["module"]);
  const isModuleObject = (expression: ts.Expression): boolean => {
    const unwrapped = unwrapExpression(expression);
    if (unwrapped !== expression) return isModuleObject(unwrapped);
    if (ts.isIdentifier(expression)) return moduleAliases.has(expression.text);
    return (
      (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
      memberName(expression) === "main" &&
      ts.isIdentifier(expression.expression) &&
      requireAliases.has(expression.expression.text)
    );
  };
  const isRequireReference = (expression: ts.Expression): boolean => {
    const unwrapped = unwrapExpression(expression);
    if (unwrapped !== expression) return isRequireReference(unwrapped);
    if (ts.isIdentifier(expression)) return requireAliases.has(expression.text);
    return (
      (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
      memberName(expression) === "require" &&
      isModuleObject(expression.expression)
    );
  };
  let aliasCount = -1;
  while (aliasCount !== requireAliases.size + moduleAliases.size) {
    aliasCount = requireAliases.size + moduleAliases.size;
    const discoverAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        if (ts.isIdentifier(node.name)) {
          if (isRequireReference(node.initializer)) requireAliases.add(node.name.text);
          if (isModuleObject(node.initializer)) moduleAliases.add(node.name.text);
        } else if (ts.isObjectBindingPattern(node.name) && isModuleObject(node.initializer)) {
          for (const element of node.name.elements) {
            if (
              bindingElementName(element) === "require" &&
              ts.isIdentifier(element.name)
            ) {
              requireAliases.add(element.name.text);
            }
          }
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        if (isRequireReference(node.right)) requireAliases.add(node.left.text);
        if (isModuleObject(node.right)) moduleAliases.add(node.left.text);
      }
      ts.forEachChild(node, discoverAliases);
    };
    discoverAliases(sourceFile);
  }
  const record = (node: ts.Node, expression: ts.Expression): void => {
    loads.push({
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      specifier: staticString(expression),
    });
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      record(node, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined
    ) {
      record(node, node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequireReference(node.expression))
    ) {
      const argument = node.arguments[0];
      if (argument !== undefined) record(node, argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return loads;
}

function bindingElementName(element: ts.BindingElement): string | undefined {
  if (element.propertyName !== undefined) return propertyName(element.propertyName);
  return ts.isIdentifier(element.name) ? element.name.text : undefined;
}

export function findControlFlagAccesses(source: string, fileName: string): ControlFlagAccess[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const aliases = new Map<string, StateAliasKind>([["state", "state"]]);
  const kindOf = (expression: ts.Expression): StateAliasKind | undefined => {
    const unwrapped = unwrapExpression(expression);
    if (unwrapped !== expression) return kindOf(unwrapped);
    if (ts.isIdentifier(expression)) return aliases.get(expression.text);
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const base = kindOf(expression.expression);
      const name = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : expression.argumentExpression === undefined
          ? undefined
          : propertyName(expression.argumentExpression);
      return base === "state" && name === "control" ? "control" : undefined;
    }
    return undefined;
  };
  let aliasCount = 0;
  while (aliasCount !== aliases.size) {
    aliasCount = aliases.size;
    const discoverAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        const initializerKind = kindOf(node.initializer);
        if (ts.isIdentifier(node.name) && initializerKind !== undefined) {
          aliases.set(node.name.text, initializerKind);
        } else if (ts.isObjectBindingPattern(node.name) && initializerKind === "state") {
          for (const element of node.name.elements) {
            if (bindingElementName(element) === "control" && ts.isIdentifier(element.name)) {
              aliases.set(element.name.text, "control");
            }
          }
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const assignedKind = kindOf(node.right);
        if (assignedKind !== undefined) aliases.set(node.left.text, assignedKind);
      }
      ts.forEachChild(node, discoverAliases);
    };
    discoverAliases(sourceFile);
  }

  const accesses: ControlFlagAccess[] = [];
  const record = (node: ts.Node, flag: string): void => {
    accesses.push({ flag, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 });
  };
  const recordBindingPattern = (pattern: ts.ObjectBindingPattern, kind: StateAliasKind): void => {
    for (const element of pattern.elements) {
      const name = bindingElementName(element);
      if (name !== undefined && CONTROL_FLAGS.has(name)) record(element, name);
      if (kind === "state" && name === "control" && ts.isObjectBindingPattern(element.name)) {
        recordBindingPattern(element.name, "control");
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const flag = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : node.argumentExpression === undefined
          ? undefined
          : propertyName(node.argumentExpression);
      if (flag !== undefined && CONTROL_FLAGS.has(flag) && kindOf(node.expression) !== undefined) record(node, flag);
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined) {
      const initializerKind = kindOf(node.initializer);
      if (initializerKind !== undefined) recordBindingPattern(node.name, initializerKind);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return accesses;
}
