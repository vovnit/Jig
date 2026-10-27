// JSON Patch (RFC 6902) on a copy of a value: how the model edits a spec. Paths are
// JSON Pointers (RFC 6901), e.g. `/screens/main/body/children/2/style/fontSize`.

export interface PatchOp {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  value?: unknown;
  from?: string;
}

export class PatchError extends Error {}

/** JSON values only, so a copy through JSON (JavaScriptCore and QuickJS have no structuredClone). */
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new PatchError(`Path must start with '/': '${pointer}'`);
  return pointer.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

type Container = Record<string, unknown> | unknown[];

/** The parent container of a path and the last key, creating nothing. */
function locate(doc: unknown, pointer: string): { parent: Container; key: string } {
  const keys = parsePointer(pointer);
  if (!keys.length) throw new PatchError("Can't change the document root with this op");
  let node = doc;
  for (const k of keys.slice(0, -1)) {
    if (!node || typeof node !== "object") throw new PatchError(`No such path: '${pointer}'`);
    node = (node as Record<string, unknown>)[Array.isArray(node) ? Number(k) : k];
  }
  if (!node || typeof node !== "object") throw new PatchError(`No such path: '${pointer}'`);
  return { parent: node as Container, key: keys.at(-1)! };
}

export function getAt(doc: unknown, pointer: string): unknown {
  let node = doc;
  for (const k of parsePointer(pointer)) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[Array.isArray(node) ? Number(k) : k];
  }
  return node;
}

function arrayIndex(arr: unknown[], key: string, forAdd: boolean): number {
  if (forAdd && key === "-") return arr.length;
  const i = Number(key);
  if (!Number.isInteger(i) || i < 0 || i > arr.length || (!forAdd && i === arr.length)) {
    throw new PatchError(`Index ${key} is out of range (length ${arr.length})`);
  }
  return i;
}

function add(doc: unknown, path: string, value: unknown): void {
  const { parent, key } = locate(doc, path);
  if (Array.isArray(parent)) parent.splice(arrayIndex(parent, key, true), 0, value);
  else parent[key] = value;
}

function remove(doc: unknown, path: string): unknown {
  const { parent, key } = locate(doc, path);
  if (Array.isArray(parent)) return parent.splice(arrayIndex(parent, key, false), 1)[0];
  if (!(key in parent)) throw new PatchError(`Nothing to remove at '${path}'`);
  const old = parent[key];
  delete parent[key];
  return old;
}

/** Applies the ops to a deep copy; throws a PatchError naming the op that failed. */
export function applyPatch<T>(doc: T, ops: PatchOp[]): T {
  const out = clone(doc);
  ops.forEach((op, i) => {
    try {
      switch (op.op) {
        case "add":
          add(out, op.path, clone(op.value));
          break;
        case "remove":
          remove(out, op.path);
          break;
        case "replace": {
          const { parent, key } = locate(out, op.path);
          if (Array.isArray(parent)) parent[arrayIndex(parent, key, false)] = clone(op.value);
          else if (!(key in parent)) throw new PatchError(`Nothing to replace at '${op.path}' (use add)`);
          else parent[key] = clone(op.value);
          break;
        }
        case "move":
          add(out, op.path, remove(out, op.from ?? ""));
          break;
        case "copy":
          add(out, op.path, clone(getAt(out, op.from ?? "")));
          break;
        case "test":
          if (JSON.stringify(getAt(out, op.path)) !== JSON.stringify(op.value)) throw new PatchError(`Test failed at '${op.path}'`);
          break;
        default:
          throw new PatchError(`Unknown op '${(op as { op: string }).op}'`);
      }
    } catch (e) {
      throw new PatchError(`Patch op ${i} (${op.op} ${op.path}): ${(e as Error).message}`);
    }
  });
  return out;
}
