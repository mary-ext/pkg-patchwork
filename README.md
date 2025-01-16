# patchwork

nifty utility for monkey-patching class constructors, methods, and accessors.

```ts
const patcher = patch(Response.prototype, 'json');

// add middleware-style hooks
patcher.hook(async (thisArg, args, next) => {
	// ... run code before the next function

	const json = await next(thisArg, args);

	// ... run code after the next function

	return json;
});

// replace the original function
patcher.instead(async (thisArg, args) => {
	return { hello: 'world' };
});

// revert when done
patcher.restore();
```
