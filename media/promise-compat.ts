type PromiseWithResolvers<T> = {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
};

type CompatiblePromiseConstructor = PromiseConstructor & {
	withResolvers?: <T>() => PromiseWithResolvers<T>;
};

// PDF.js 4 uses this newer Promise API; VS Code 1.85's embedded Chromium may not have it yet.
const compatiblePromise = Promise as CompatiblePromiseConstructor;
if (typeof compatiblePromise.withResolvers !== "function") {
	compatiblePromise.withResolvers = <T>(): PromiseWithResolvers<T> => {
		let resolve!: PromiseWithResolvers<T>["resolve"];
		let reject!: PromiseWithResolvers<T>["reject"];
		const promise = new Promise<T>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		return { promise, resolve, reject };
	};
}
