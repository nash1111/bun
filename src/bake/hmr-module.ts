// This is an implementation of an ES module loader with hot-module reloading support.
//
// TODO: solve a major design flaw where circular dependencies initialize stuff
// wrong, as well as the over-aggressive use of async functions.
import * as runtimeHelpers from "../runtime.bun.js";

let refreshRuntime: any;
const registry = new Map<Id, HotModule>();

const asyncFunctionPrototype = Object.getPrototypeOf(async function () {});
function isAsyncFunction(fn: Function) {
  return Object.getPrototypeOf(fn) === asyncFunctionPrototype;
}

export type ModuleLoadFunction = (module: HotModule) => void;
export type ExportsCallbackFunction = (new_exports: any) => void;

export const enum State {
  Loading,
  Ready,
  Error,
  Replacing,
}

// negative = sync, positive = async
export const enum LoadModuleType {
  AsyncAssertPresent = 1,
  AsyncUserDynamic = 2,
  SyncUserDynamic = -1,
}

interface DepEntry {
  _callback: ExportsCallbackFunction;
  _expectedImports: string[] | undefined;
}

/** See `runtime.js`'s `__toCommonJS`. This omits the cache. */
export var toCommonJSUncached = /* @__PURE__ */ from => {
  var desc,
    entry = Object.defineProperty({}, "__esModule", { value: true });
  if ((from && typeof from === "object") || typeof from === "function")
    Object.getOwnPropertyNames(from).map(
      key =>
        !Object.prototype.hasOwnProperty.call(entry, key) &&
        Object.defineProperty(entry, key, {
          get: () => from[key],
          enumerable: !(desc = Object.getOwnPropertyDescriptor(from, key)) || desc.enumerable,
        }),
    );
  return entry;
};

/**
 * The expression `import(a,b)` is not supported in all browsers, most notably
 * in Mozilla Firefox. It is lazily evaluated, and will throw a SyntaxError
 * upon first usage.
 */
let lazyDynamicImportWithOptions;

const kDebugModule = /* @__PURE__ */ Symbol("HotModule");

/**
 * This object is passed as the CommonJS "module", but has a bunch of
 * non-standard properties that are used for implementing hot-module reloading.
 * It is unacceptable for users to depend on these properties, and it will not
 * be considered a breaking change when these internals are altered.
 */
export class HotModule<E = any> {
  id: Id;
  exports: E = {} as E;

  _state = State.Loading;
  /** for MJS <-> CJS interop. this stores the other module exports */
  _ext_exports = undefined;
  _esm = false;
  _cached_failure: any = undefined;
  /** modules that import THIS module */
  _deps: Map<HotModule, DepEntry | undefined> = new Map();
  /** from `import.meta.hot.dispose` */
  _onDispose: HotDisposeFunction[] | undefined = undefined;

  constructor(id: Id) {
    this.id = id;

    if (IS_BUN_DEVELOPMENT) {
      Object.defineProperty(this.exports, kDebugModule, {
        value: this,
        enumerable: false,
      });
    }

    this.require = this.require.bind(this);
  }

  require(id: Id, onReload?: ExportsCallbackFunction) {
    const mod = loadModule(id, LoadModuleType.SyncUserDynamic) as HotModule;
    mod._deps.set(this, onReload ? { _callback: onReload, _expectedImports: undefined } : undefined);
    const { exports, _esm } = mod;
    return _esm ? (mod._ext_exports ??= runtimeHelpers.__toCommonJS(exports)) : exports;
  }

  async importStmt(id: Id, onReload?: ExportsCallbackFunction, expectedImports?: string[]) {
    const mod = await (loadModule(id, LoadModuleType.AsyncAssertPresent) as Promise<HotModule>);
    mod._deps.set(this, onReload ? { _callback: onReload, _expectedImports: expectedImports } : undefined);
    const { exports, _esm } = mod;
    const object = _esm ? exports : (mod._ext_exports ??= runtimeHelpers.__toESM(exports));
    // TODO: ESM rewrite
    return object;
  }

  /// Equivalent to `import()` in ES modules
  async dynamicImport(specifier: string, opts?: ImportCallOptions) {
    if (!registry.has(specifier) && !input_graph[specifier]) {
      try {
        if (opts != null)
          return await (lazyDynamicImportWithOptions ??= new Function("specifier, opts", "import(specifier, opts)"))(
            specifier,
            opts,
          );
        return await import(specifier);
      } catch (err) {
        // fall through to loadModule, which will throw a more specific error.
        // but still show this one.
        console.error(err);
      }
    }
    const mod = await (loadModule(specifier, LoadModuleType.AsyncUserDynamic) as Promise<HotModule>);
    // insert into the map if not present
    mod._deps.set(this, mod._deps.get(this));
    const { exports, _esm } = mod;
    return _esm ? exports : (mod._ext_exports ??= { ...exports, default: exports });
  }

  get importMeta() {
    const importMeta = initImportMeta(this);
    Object.defineProperty(this, "importMeta", { value: importMeta });
    return importMeta;
  }

  get hot() {
    const hot = new Hot(this);
    Object.defineProperty(this, "hot", { value: hot });
    return hot;
  }

  /** Server-only */
  declare importBuiltin: (id: string) => any;
}

if (side === "server") {
  HotModule.prototype.importBuiltin = function (id: string) {
    return import.meta.require(id);
  };
}

const enumerableEntries = ["id", "exports", "require"];
for (const k in HotModule.prototype) {
  if (!enumerableEntries.includes(k)) {
    const descriptor = Object.getOwnPropertyDescriptor(HotModule.prototype, k);
    if (descriptor) {
      Object.defineProperty(HotModule.prototype, k, { ...descriptor, enumerable: false });
    }
  }
}

function initImportMeta(m: HotModule): ImportMeta {
  return {
    url: `bun://${m.id}`,
    main: false,
    // @ts-ignore
    require: m.require,
    // transpiler rewrites `import.meta.hot` to access `HotModule.hot`
  };
}

type HotAcceptFunction = (esmExports: any | void) => void;
type HotArrayAcceptFunction = (esmExports: (any | void)[]) => void;
type HotDisposeFunction = (data: any) => void;
type HotEventHandler = (data: any) => void;

class Hot {
  #module: HotModule;

  data = {};

  constructor(module: HotModule) {
    this.#module = module;
  }

  accept(
    arg1: string | readonly string[] | HotAcceptFunction,
    arg2: HotAcceptFunction | HotArrayAcceptFunction | undefined,
  ) {
    console.warn("TODO: implement ImportMetaHot.accept (called from " + JSON.stringify(this.#module.id) + ")");
  }

  acceptSpecifiers(specifiers: string | readonly string[], cb?: HotAcceptFunction) {
    console.warn("TODO: implement ImportMetaHot.accept (called from " + JSON.stringify(this.#module.id) + ")");
  }

  decline() {} // Vite: "This is currently a noop and is there for backward compatibility"

  dispose(cb: HotDisposeFunction) {
    (this.#module._onDispose ??= []).push(cb);
  }

  prune(cb: HotDisposeFunction) {
    throw new Error("TODO: implement ImportMetaHot.prune");
  }

  invalidate() {
    throw new Error("TODO: implement ImportMetaHot.invalidate");
  }

  on(event: string, cb: HotEventHandler) {
    if (isUnsupportedViteEventName(event)) {
      throw new Error(`Unsupported event name: ${event}`);
    }

    throw new Error("TODO: implement ImportMetaHot.on");
  }

  off(event: string, cb: HotEventHandler) {
    throw new Error("TODO: implement ImportMetaHot.off");
  }

  send(event: string, cb: HotEventHandler) {
    throw new Error("TODO: implement ImportMetaHot.send");
  }
}

function isUnsupportedViteEventName(str: string) {
  return (
    str === "vite:beforeUpdate" ||
    str === "vite:afterUpdate" ||
    str === "vite:beforeFullReload" ||
    str === "vite:beforePrune" ||
    str === "vite:invalidate" ||
    str === "vite:error" ||
    str === "vite:ws:disconnect" ||
    str === "vite:ws:connect"
  );
}

/**
 * Load a module by ID. Use `type` to specify if the module is supposed to be
 * present, or is something a user is able to dynamically specify.
 */
export function loadModule<T = any>(
  key: Id,
  type: LoadModuleType,
  opts?: ImportCallOptions,
): HotModule<T> | Promise<HotModule<T>> {
  let mod = registry.get(key);
  if (mod) {
    // Preserve failures until they are re-saved.
    if (mod._state == State.Error) throw mod._cached_failure;
    if (mod._state != State.Replacing) return mod;
  } else {
    mod = new HotModule(key);
  }
  const load = input_graph[key];
  if (type < 0 && isAsyncFunction(load)) {
    // TODO: This is possible to implement, but requires some care. (ESM rewrite)
    throw new Error("Cannot load ES module synchronously");
  }
  if (!load) {
    if (type == LoadModuleType.AsyncAssertPresent) {
      throw new Error(
        `Failed to load bundled module '${key}'. This is not a dynamic import, and therefore is a bug in Bun's bundler.`,
      );
    } else {
      throw new Error(
        `Failed to resolve dynamic import '${key}'. With Bun's DevServer, all imports must be statically known at build time so that the bundler can trace everything.`,
      );
    }
  }
  try {
    registry.set(key, mod);
    const promise = load(mod);
    if (promise) {
      if (IS_BUN_DEVELOPMENT) {
        if (type !== LoadModuleType.AsyncUserDynamic && type !== LoadModuleType.AsyncAssertPresent) {
          throw new Error("Did not expect a promise from loadModule");
        }
        if (!(promise instanceof Promise)) {
          throw new Error("Expected a promise from loadModule");
        }
      }
      return promise.then(
        () => {
          mod._state = State.Ready;
          mod._deps.forEach((entry, dep) => {
            entry?._callback(mod.exports);
          });
          return mod;
        },
        err => {
          mod._cached_failure = err;
          mod._state = State.Error;
          throw err;
        },
      );
    }
    mod._state = State.Ready;
    mod._deps.forEach((entry, dep) => {
      entry?._callback(mod.exports);
    });
  } catch (err) {
    mod._cached_failure = err;
    mod._state = State.Error;
    throw err;
  }
  return mod;
}

export const getModule = registry.get.bind(registry);

export function replaceModule(key: Id, load: ModuleLoadFunction): Promise<void> | void {
  const module = registry.get(key);
  if (module && module._state == State.Replacing) {
    module._onDispose?.forEach(cb => cb(null));
    const promise = load(module) as Promise<void> | undefined;
    if (promise) {
      return promise.then(() => {
        const { exports } = module;
        for (const updater of module._deps.values()) {
          updater?._callback?.(exports);
        }
      });
    }
    const { exports } = module;
    for (const updater of module._deps.values()) {
      updater?._callback?.(exports);
    }
  }
}

export async function replaceModules(modules: any) {
  let needsHardReload = false;
  for (const k in modules) {
    input_graph[k] = modules[k];
    const mod = registry.get(k);
    if (mod) {
      mod._onDispose?.forEach(cb => cb(null));
      mod._state = State.Replacing;
      mod.exports = {};
      mod._ext_exports = undefined;
      if (side === "client" && !config.refresh && !needsHardReload) {
        // TODO: import meta hot
        needsHardReload = true;
        console.info("[Bun] Reloading because there was not an `import.meta.hot.accept` boundary");
        location.reload();
        return;
      }
    }
  }
  const promises: Promise<void>[] = [];
  for (const k in modules) {
    try {
      const p = replaceModule(k, modules[k]);
      if (p) {
        promises.push(p);
      }
    } catch (err) {
      // TODO: overlay for client
      console.error(err);
    }
  }
  if (promises.length) {
    try {
      await Promise.all(promises);
    } catch (err) {
      console.error(err);
    }
  }
  if (side === "client") {
    if (refreshRuntime) {
      refreshRuntime.performReactRefresh(window);
    }
  }
}

{
  const runtime = new HotModule("bun:wrap");
  runtime.exports = runtimeHelpers;
  runtime._esm = true;
  registry.set("bun:wrap", runtime);
}

export const serverManifest = {};
export const ssrManifest = {};

export let onServerSideReload: (() => Promise<void>) | null = null;

if (side === "server") {
  const server_module = new HotModule("bun:bake/server");
  server_module._esm = true;
  server_module.exports = { serverManifest, ssrManifest, actionManifest: null };
  registry.set(server_module.id, server_module);
}

if (side === "client") {
  const { refresh } = config;
  if (refresh) {
    refreshRuntime = (await loadModule(refresh, LoadModuleType.AsyncAssertPresent)).exports;
    refreshRuntime.injectIntoGlobalHook(window);
  }

  const server_module = new HotModule("bun:bake/client");
  server_module._esm = true;
  server_module.exports = {
    onServerSideReload: async cb => {
      onServerSideReload = cb;
    },
  };
  registry.set(server_module.id, server_module);
}

runtimeHelpers.__name(HotModule.prototype.importStmt, "<Bun HMR Runtime> importStmt");
runtimeHelpers.__name(HotModule.prototype.dynamicImport, "<Bun HMR Runtime> import");
runtimeHelpers.__name(HotModule.prototype.require, "<Bun HMR Runtime> require");
runtimeHelpers.__name(loadModule, "<Bun HMR Runtime> loadModule");
