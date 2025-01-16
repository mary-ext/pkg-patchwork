// deno-lint-ignore-file no-explicit-any

type Procedure = (...args: any[]) => any;

type Methods<T> = keyof {
	[K in keyof T as T[K] extends Procedure ? K : never]: T[K];
};
type Properties<T> =
	& {
		[K in keyof T]: T[K] extends Procedure ? never : K;
	}[keyof T]
	& (string | symbol);
type Classes<T> =
	& {
		[K in keyof T]: T[K] extends new (...args: any[]) => any ? K : never;
	}[keyof T]
	& (string | symbol);

/** generic type that represents a middleware function */
type Middleware<TParams extends any[], TReturn> = (
	...params: [...TParams, next: (...params: TParams) => TReturn]
) => TReturn;

/** infers the shape of a `next` function from a middleware */
type MiddlewareNext<T> = T extends Middleware<infer TParams, infer TReturn> ? (...params: TParams) => TReturn
	: never;

/** represents a middleware for procedure patches */
type PatchMiddleware<T extends Procedure = Procedure> = Middleware<
	[thisArg: ThisParameterType<T>, args: Parameters<T>],
	ReturnType<T>
>;

/**
 * represents a patching interface for modifying the behavior of a function or method.
 * @template T the function being patched
 */
interface PatchInstance<T extends Procedure = Procedure> {
	/**
	 * adds a middleware into the patch
	 * @param fn middleware function
	 * @returns function that removes the added middleware.
	 */
	hook: (fn: PatchMiddleware<T>) => () => void;
	/**
	 * removes an added middleware from the patch
	 * @param fn middleware function that was previously added in
	 */
	unhook: (fn: PatchMiddleware<T>) => void;
	/**
	 * replaces the original function with a new implementation
	 * @param fn the function to use, or `undefined` to clear it
	 */
	instead: (fn: MiddlewareNext<PatchMiddleware<T>> | undefined) => void;
	/**
	 * restores the original function, this patch interface will be rendered
	 * unusable, and you'd need to call `patch()` again to get a new one.
	 */
	restore: () => void;
	/**
	 * removes all middlewares and the instead function
	 */
	clear: () => void;
}

const patches = new WeakMap<Procedure, PatchInstance>();

/**
 * creates a patch for a property getter, method, or constructor of an object
 *
 * @template T object being patched
 * @template K property name of a method/property being patched
 *
 * @param obj object to patch
 * @param name property name of a method/property to patch
 * @param type on properties, which part of the accessor to patch (getter/setter)
 *
 * @returns a PatchInstance for managing patches
 *
 * @example
 *
 * // patching properties/accessors
 * const patcher = patch(Response.prototype, 'body', 'get');
 *
 * // patching methods
 * const patcher = patch(Response.prototype, 'json');
 *
 * // adding a middleware
 * patcher.hook((thisArg, args, next) => {
 *   console.log('before call');
 *   const result = next(thisArg, args);
 *   console.log('after method call');
 *   return result;
 * });
 */
export function patch<T, S extends Properties<Required<T>>>(
	obj: T,
	propertyName: S,
	accessType: 'get',
): PatchInstance<() => T[S]>;
export function patch<T, G extends Properties<Required<T>>>(
	obj: T,
	propertyName: G,
	accessType: 'set',
): PatchInstance<(arg: T[G]) => void>;
export function patch<T, M extends Classes<Required<T>> | Methods<Required<T>>>(
	obj: T,
	methodName: M,
): Required<T>[M] extends { new (...args: infer A): infer R } ? PatchInstance<(this: R, ...args: A) => R>
	: T[M] extends Procedure ? PatchInstance<T[M]>
	: never;
export function patch<T, K extends keyof T>(
	obj: T,
	name: K,
	type: 'get' | 'set' | 'value' = 'value',
): PatchInstance {
	const descriptor = Object.getOwnPropertyDescriptor(obj, name);
	assert(descriptor, `can't get a descriptor`);

	const origin = descriptor[type];
	assert(typeof origin === 'function', `expected descriptor.${type} to be a function`);

	{
		const patched = patches.get(origin);
		if (patched) {
			return patched;
		}
	}

	let hooks: PatchMiddleware[] = [];
	let runConstruct: MiddlewareNext<PatchMiddleware> | null | undefined = null;
	let runApply: MiddlewareNext<PatchMiddleware> | null | undefined = null;
	let insteadFn: MiddlewareNext<PatchMiddleware> | undefined;

	const proxy = new Proxy(origin, {
		construct(target, args, newTarget) {
			if (runConstruct === null) {
				return insteadFn ? insteadFn(undefined, args) : Reflect.construct(target, args);
			}

			if (runConstruct === undefined) {
				runConstruct = hooks.reduceRight<MiddlewareNext<PatchMiddleware>>(
					(next, run) => (thisArg, args) => run(thisArg, args, next),
					insteadFn ?? ((_thisArg, args) => Reflect.construct(target, args, newTarget)),
				);
			}

			return runConstruct(undefined, args);
		},
		apply(target, thisArg, args) {
			if (runApply === null) {
				return insteadFn ? insteadFn(thisArg, args) : Reflect.construct(target, args);
			}

			if (runApply === undefined) {
				runApply = hooks.reduceRight<MiddlewareNext<PatchMiddleware>>(
					(next, run) => (thisArg, args) => run(thisArg, args, next),
					insteadFn ?? ((thisArg, args) => Reflect.apply(target, thisArg, args)),
				);
			}

			return runApply(thisArg, args);
		},
	});

	const instance: PatchInstance = {
		hook(fn) {
			(hooks ??= []).push(fn);
			runConstruct = runApply = undefined;

			return this.unhook.bind(this, fn);
		},
		unhook(fn) {
			if (!hooks) {
				return;
			}

			const index = hooks.indexOf(fn);
			if (index !== -1) {
				runConstruct = runApply = hooks.length === 1 ? null : undefined;
				hooks.splice(index, 1);
			}
		},
		instead(fn) {
			insteadFn = fn;

			if (hooks.length !== 0) {
				runConstruct = runApply = undefined;
			}
		},
		clear() {
			hooks = [];
			insteadFn = undefined;

			runConstruct = runApply = null;
		},
		restore() {
			this.clear();

			Object.defineProperty(obj, name, descriptor);
			patches.delete(proxy);
		},
	};

	{
		const { value: _value, ...desc } = descriptor || { configurable: true, writable: true };

		if (type !== 'value') {
			delete desc.writable; // getter/setter can't have writable attribute at all
		}

		(desc as PropertyDescriptor)[type] = proxy;
		Object.defineProperty(obj, name, desc);
	}

	patches.set(proxy, instance);
	return instance;
}

function assert(condition: any, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}
