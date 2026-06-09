import * as path from "node:path";

/**
 * Returns true for Java production classes that should be covered by the TDD gate.
 * DTO/entity/repository/config-style artifacts are intentionally excluded because
 * they are usually exercised through service/controller tests rather than direct
 * test-first class creation.
 */
export function isProductionClassPath(filePath: string, gitRoot: string): boolean {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(gitRoot, filePath);
  const normalized = path.relative(gitRoot, absolutePath).replace(/\\/g, "/");
  if (!/^src\/main\/java\/.+\.java$/.test(normalized)) return false;
  if (/(^|\/)(dto|entity|model|repository)\//.test(normalized)) return false;
  const className = path.basename(normalized, ".java");
  if (/^Q[A-Z]|^Migration/.test(className)) return false;
  const EXCLUDE = /(Entity|Dto|VO|Vo|Request|Response|Payload|Config|Configuration|Application|Properties|Settings|Exception|Error|Enum|Record|Constants|Constant|Event|Message|Projection|Form)$/i;
  return !EXCLUDE.test(className);
}
