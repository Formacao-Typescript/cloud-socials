type AClass = new (...args: any) => any;
type Methods<T> = {
	[K in keyof T]: T[K] extends Function ? K extends string ? K : never : never;
}[keyof T];

export type InstanceDoble<T extends AClass> = InstanceType<T> & {
	allow: (
		method: Methods<InstanceType<T>>,
		value: ReturnType<InstanceType<T>[typeof method]>,
		times?: number,
	) => InstanceDoble<T>;
	calls: (method: Methods<InstanceType<T>>) => Set<{ args: any[] }>;
};

export function instanceDummy<T extends AClass>(klass: T): InstanceType<T> {
	return new Proxy({} as InstanceType<T>, {
		get(_, prop) {
			if (prop === 'constructor') return klass;
			if (typeof klass.prototype[prop] === 'function') return () => {};
			return klass.prototype[prop];
		},
	});
}

export function instanceDouble<T extends AClass>(
	klass: T,
): InstanceDoble<T> {
	const methods: Map<keyof InstanceType<T>, Set<any>> = new Map();
	const calls: Map<keyof InstanceType<T>, Set<any>> = new Map();

	const proxy = new Proxy({} as InstanceType<T>, {
		get(_target, prop, _receiver) {
			if (prop === 'constructor') return klass;

			if (typeof prop === 'symbol') return undefined;

			if (prop === 'allow') {
				return (
					method: keyof InstanceType<T>,
					value: ReturnType<InstanceType<T>[typeof method]>,
					times = 1,
				): InstanceDoble<T> => {
					const resultSet = methods.get(method) ?? new Set();
					for (let i = 0; i < times; i++) {
						resultSet.add(value);
					}
					methods.set(method, resultSet);
					return proxy;
				};
			}

			if (prop === 'calls') {
				return (method: keyof InstanceType<T>) => calls.get(method) ?? new Set();
			}

			if (methods.has(prop)) {
				const resultSet = methods.get(prop);
				if (!resultSet) throw new Error(`Method \`${prop}\` has no results left`);
				const result = resultSet.values().next();
				if (result.done) methods.delete(prop);
				return (...args: any) => {
					const callSet = calls.get(prop) ?? new Set();
					callSet.add({ args });
					calls.set(prop, callSet);
					return result.value;
				};
			}

			throw new Error(`Received call to unknown method \`${prop}\``);
		},
		set() {
			throw new Error('Operation not allowed');
		},
	});

	return proxy;
}
