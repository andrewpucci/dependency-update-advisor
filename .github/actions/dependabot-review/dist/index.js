import { createRequire } from "node:module";
import { Duplex, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { types } from "node:util";

// \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod, mod.exports), cb = null), mod.exports);
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) {
		__defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	}
	if (!no_symbols) {
		__defProp(target, Symbol.toStringTag, { value: "Module" });
	}
	return target;
};
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") {
		for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
			key = keys[i];
			if (!__hasOwnProp.call(to, key) && key !== except) {
				__defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
		}
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();

// node_modules/stream-chain/src/defs.js
var defs_exports = /* @__PURE__ */ __exportAll({
	Stop: () => Stop,
	abortSymbol: () => abortSymbol,
	clearFunctionList: () => clearFunctionList,
	combineMany: () => combineMany,
	combineManyMut: () => combineManyMut,
	fListSymbol: () => fListSymbol,
	final: () => final$1,
	finalSymbol: () => finalSymbol,
	finalValue: () => finalValue,
	flushSymbol: () => flushSymbol,
	flushable: () => flushable,
	getFinalValue: () => getFinalValue,
	getFunctionList: () => getFunctionList,
	getManyValues: () => getManyValues,
	isDuplexNodeStream: () => isDuplexNodeStream$1,
	isDuplexWebStream: () => isDuplexWebStream$1,
	isFinalValue: () => isFinalValue,
	isFlushable: () => isFlushable,
	isFunctionList: () => isFunctionList,
	isMany: () => isMany,
	isReadableNodeStream: () => isReadableNodeStream$1,
	isReadableWebStream: () => isReadableWebStream$1,
	isStop: () => isStop,
	isWritableNodeStream: () => isWritableNodeStream$1,
	isWritableWebStream: () => isWritableWebStream$1,
	many: () => many,
	manySymbol: () => manySymbol,
	none: () => none,
	normalizeMany: () => normalizeMany,
	setFunctionList: () => setFunctionList,
	stop: () => stop,
	stopErrorSymbol: () => stopErrorSymbol,
	toMany: () => toMany
});
const none = Symbol.for("object-stream.none");
const stop = Symbol.for("object-stream.stop");
const finalSymbol = Symbol.for("object-stream.final");
const manySymbol = Symbol.for("object-stream.many");
const flushSymbol = Symbol.for("object-stream.flush");
const abortSymbol = Symbol.for("object-stream.abort");
const fListSymbol = Symbol.for("object-stream.fList");
const stopErrorSymbol = Symbol.for("object-stream.stopError");
const finalValue = (value) => ({
	[finalSymbol]: 1,
	value
});
const many = (values) => ({
	[manySymbol]: 1,
	values
});
const isFinalValue = (o) => o && o[finalSymbol] === 1;
const isMany = (o) => o && o[manySymbol] === 1;
const isFlushable = (o) => o && o[flushSymbol] === 1;
const isFunctionList = (o) => o && o[fListSymbol] === 1;
const isStop = (o) => o && o[stopErrorSymbol] === 1;
const getFinalValue = (o) => o.value;
const getManyValues = (o) => o.values;
const getFunctionList = (o) => o.fList;
const flushable = (write, final = null, abort = null) => {
	const fn = final ? (value) => value === none ? final() : write(value) : write;
	fn[flushSymbol] = 1;
	if (abort) fn[abortSymbol] = abort;
	return fn;
};
const setFunctionList = (o, fns) => {
	o.fList = fns;
	o[fListSymbol] = 1;
	return o;
};
const clearFunctionList = (o) => {
	delete o.fList;
	delete o[fListSymbol];
	return o;
};
var Stop = class extends Error {};
Stop.prototype[stopErrorSymbol] = 1;
const toMany = (value) => value === none ? many([]) : value && value[manySymbol] === 1 ? value : many([value]);
const normalizeMany = (o) => {
	if (o?.[manySymbol] === 1) switch (o.values.length) {
		case 0: return none;
		case 1: return o.values[0];
	}
	return o;
};
const combineMany = (...args) => {
	const values = [];
	for (let i = 0; i < args.length; ++i) {
		const a = args[i];
		if (a === none) continue;
		if (a?.[manySymbol] === 1) values.push(...a.values);
		else values.push(a);
	}
	return many(values);
};
const combineManyMut = (a, ...args) => {
	const values = a === none ? [] : a?.[manySymbol] === 1 ? a.values : [a];
	for (let i = 0; i < args.length; ++i) {
		const b = args[i];
		if (b === none) continue;
		if (b?.[manySymbol] === 1) values.push(...b.values);
		else values.push(b);
	}
	return many(values);
};
const isReadableWebStream$1 = (x) => !!(x && typeof x === "object" && typeof x.getReader === "function" && typeof x.pipeTo === "function");
const isWritableWebStream$1 = (x) => !!(x && typeof x === "object" && typeof x.getWriter === "function" && typeof x.abort === "function");
const isDuplexWebStream$1 = (x) => !!(x && typeof x === "object" && isReadableWebStream$1(x.readable) && isWritableWebStream$1(x.writable));
const isReadableNodeStream$1 = (obj) => obj && typeof obj.pipe === "function" && typeof obj.on === "function" && (!obj._writableState || (typeof obj._readableState === "object" ? obj._readableState.readable : null) !== false) && (!obj._writableState || obj._readableState);
const isWritableNodeStream$1 = (obj) => obj && typeof obj.write === "function" && typeof obj.on === "function" && (!obj._readableState || (typeof obj._writableState === "object" ? obj._writableState.writable : null) !== false);
const isDuplexNodeStream$1 = (obj) => obj && typeof obj.pipe === "function" && obj._readableState && typeof obj.on === "function" && typeof obj.write === "function";
const final$1 = finalValue;

// node_modules/stream-chain/src/exec.js
const cancelSymbol = Symbol.for("object-stream.cancel");
const dropNullSymbol = Symbol.for("object-stream.dropNull");
const stopAtSymbol = Symbol.for("object-stream.stopAt");
const GEN_CANCEL = Symbol.for("object-stream.genCancel");
const markStop = (error, index) => {
	if (isStop(error)) error[stopAtSymbol] = index;
	throw error;
};
const stopIndex = (stop, fns) => stop[stopAtSymbol] ?? fns.length;
const withCleanupError = (err, cleanupErr) => {
	if (err == null || isStop(err)) return cleanupErr;
	return err instanceof Error ? new AggregateError([err, cleanupErr], "pipeline error; generator cleanup also failed") : err;
};
const hasAborters = (fns) => fns.some((fn) => fn[abortSymbol]);
const noteFinal = (value, fn, finished) => {
	if (value && typeof value.then == "function") return value.then((v) => (finished.add(fn), v));
	finished.add(fn);
	return value;
};
const abortStages = async (fns, finished, to = fns.length) => {
	let failure;
	for (let i = 0; i < to; ++i) {
		const fn = fns[i], abort = fn[abortSymbol];
		if (!abort || finished.has(fn)) continue;
		finished.add(fn);
		try {
			await abort();
		} catch (error) {
			failure = failure === void 0 ? error : new AggregateError([failure, error], "stage cleanup failed more than once");
		}
	}
	return failure;
};
const next = (value, fns, index, push) => {
	for (let i = index;;) {
		if (value && typeof value.then == "function") {
			const ii = i;
			return value.then((v) => next(v, fns, ii, push), (e) => markStop(e, ii));
		}
		if (value === none || value == null && push[dropNullSymbol]) return void 0;
		if (value === stop) markStop(new Stop(), i);
		if (isFinalValue(value)) {
			const final = getFinalValue(value);
			if (final == null && push[dropNullSymbol]) return void 0;
			return push(final);
		}
		if (isMany(value)) return nextMany(getManyValues(value), fns, i, push);
		if (value && typeof value.next == "function") return nextGen(value, fns, i, push);
		if (i >= fns.length) return push(value);
		try {
			value = fns[i++](value);
		} catch (error) {
			markStop(error, i);
		}
	}
};
const nextMany = (values, fns, i, push) => {
	const step = (j) => {
		for (; j < values.length; ++j) {
			const r = next(values[j], fns, i, push);
			if (r && typeof r.then == "function") {
				const jj = j;
				return r.then(() => step(jj + 1));
			}
		}
	};
	return step(0);
};
const nextGen = (it, fns, i, push) => {
	const step = () => {
		for (;;) {
			if (push[cancelSymbol]) throw push[cancelSymbol];
			let data;
			try {
				data = it.next();
			} catch (error) {
				markStop(error, i);
			}
			if (data && typeof data.then == "function") return data.then((d) => {
				if (d.done) return;
				const r = next(d.value, fns, i, push);
				return r && typeof r.then == "function" ? r.then(step) : step();
			}, (e) => markStop(e, i));
			if (data.done) return;
			const r = next(data.value, fns, i, push);
			if (r && typeof r.then == "function") return r.then(step);
		}
	};
	const abort = (err) => {
		const onCleanupError = (cleanupErr) => withCleanupError(err, cleanupErr);
		let ret;
		try {
			ret = it.return ? it.return() : void 0;
		} catch (cleanupErr) {
			throw onCleanupError(cleanupErr);
		}
		if (ret && typeof ret.then == "function") return ret.then(() => {
			throw err;
		}, (cleanupErr) => {
			throw onCleanupError(cleanupErr);
		});
		throw err;
	};
	let r;
	try {
		r = step();
	} catch (err) {
		return abort(err);
	}
	return r && typeof r.then == "function" ? r.then(void 0, abort) : r;
};
const flush = (fns, index, push, finished) => {
	let stop = null;
	const resume = (error) => {
		if (!isStop(error)) throw error;
		stop = error;
		return step(stopIndex(error, fns));
	};
	const step = (i) => {
		for (; i < fns.length; ++i) {
			const f = fns[i];
			if (!isFlushable(f) || finished?.has(f)) continue;
			let r;
			try {
				let value;
				try {
					value = f(none);
				} catch (error) {
					markStop(error, i + 1);
				}
				if (finished) value = noteFinal(value, f, finished);
				r = next(value, fns, i + 1, push);
			} catch (error) {
				return resume(error);
			}
			if (r && typeof r.then == "function") {
				const ii = i;
				return r.then(() => step(ii + 1), resume);
			}
		}
		if (stop) throw stop;
	};
	return step(index);
};
const releaseStopped = async (fns, finished, stop) => {
	const failure = await abortStages(fns, finished, stopIndex(stop, fns));
	if (failure === void 0) return void 0;
	const more = await abortStages(fns, finished);
	return more === void 0 ? failure : new AggregateError([failure, more], "stage cleanup failed more than once");
};
const finishStop = async (fns, stop, push, finished) => {
	let error;
	try {
		await flush(fns, stopIndex(stop, fns), push, finished);
	} catch (e) {
		if (isStop(e)) stop = e;
		else error = e;
	}
	const failure = error === void 0 ? await releaseStopped(fns, finished, stop) : await abortStages(fns, finished);
	if (failure !== void 0) error = withCleanupError(error, failure);
	if (error !== void 0) throw error;
};
const genBridge = (fns, once) => {
	fns = fns.filter((fn) => fn).flat(Infinity).map((fn) => isFunctionList(fn) ? getFunctionList(fn) : fn).flat(Infinity);
	if (!fns.length) fns = [(x) => x];
	const canAbort = hasAborters(fns), finished = /* @__PURE__ */ new Set();
	let flushed = false, stopAt = 0;
	const drive = async (value, push) => {
		try {
			await next(value, fns, 0, push);
		} catch (error) {
			if (!isStop(error)) throw error;
			await finishStop(fns, error, push, finished);
			throw error;
		}
		await flush(fns, 0, push, finished);
	};
	let g = async function* (value) {
		if (flushed) throw Error("Call to a flushed pipe.");
		const isFlush = !once && value === none;
		if (isFlush || once) flushed = true;
		const pending = [];
		/** @type {((value?: any) => void) | null} */
		let wakeConsumer = null;
		/** @type {((value?: any) => void) | null} */
		let resolveProducer = null;
		/** @type {((reason?: any) => void) | null} */
		let rejectProducer = null;
		let done = false, error = null, cancelled = false, completed = false;
		const push = (v) => {
			if (cancelled) throw GEN_CANCEL;
			pending.push(v);
			if (wakeConsumer) {
				const w = wakeConsumer;
				wakeConsumer = null;
				w();
			}
			return new Promise((res, rej) => {
				resolveProducer = res;
				rejectProducer = rej;
			});
		};
		Promise.resolve().then(() => once ? drive(value, push) : isFlush ? flush(fns, stopAt, push, finished) : next(value, fns, 0, push)).then(() => {}, (e) => {
			if (e === GEN_CANCEL) return;
			error = e;
			if (!isFlush && isStop(e)) stopAt = stopIndex(e, fns);
		}).finally(() => {
			done = true;
			if (wakeConsumer) {
				const w = wakeConsumer;
				wakeConsumer = null;
				w();
			}
		});
		try {
			for (;;) {
				while (pending.length) {
					const v = pending.shift();
					if (resolveProducer) {
						const r = resolveProducer;
						resolveProducer = rejectProducer = null;
						r();
					}
					yield v;
				}
				if (error) throw error;
				if (done) {
					completed = true;
					return;
				}
				await new Promise((res) => wakeConsumer = res);
			}
		} finally {
			cancelled = true;
			push[cancelSymbol] = GEN_CANCEL;
			if (rejectProducer) {
				const rj = rejectProducer;
				resolveProducer = rejectProducer = null;
				rj(GEN_CANCEL);
			}
			if (!completed && canAbort) {
				const failure = isStop(error) ? await releaseStopped(fns, finished, error) : await abortStages(fns, finished);
				if (failure !== void 0) throw withCleanupError(error, failure);
			}
		}
	};
	if (once) return g;
	if (fns.some((fn) => isFlushable(fn))) g = flushable(g);
	return setFunctionList(g, fns);
};

// node_modules/stream-chain/src/gen.js
const gen = (...fns) => genBridge(fns, false);

// node_modules/stream-chain/src/asStream.js
const CANCEL$1 = Symbol.for("object-stream.asStreamCancel");
const asStream = (fn, options) => {
	if (typeof fn != "function") throw TypeError("Only a function is accepted as the first argument");
	const innerFns = isFunctionList(fn) ? fn.fList : null;
	const stages = innerFns ?? [fn];
	const canAbort = hasAborters(stages), finished = /* @__PURE__ */ new Set();
	let stopped = false;
	let destroyed = false;
	let flushed = false;
	let nullPushed = false;
	let resolvePaused = null;
	let rejectPaused = null;
	let stream = null;
	const resume = () => {
		if (!resolvePaused) return;
		const resolve = resolvePaused;
		resolvePaused = rejectPaused = null;
		resolve();
	};
	const cancelPaused = () => {
		if (!rejectPaused) return;
		const reject = rejectPaused;
		resolvePaused = rejectPaused = null;
		reject(CANCEL$1);
	};
	const signalEnd = () => {
		if (nullPushed) return;
		nullPushed = true;
		stream.push(null);
	};
	const enqueue = (value) => {
		if (destroyed) throw CANCEL$1;
		if (nullPushed) return;
		if (!stream.push(value)) return new Promise((resolve, reject) => {
			resolvePaused = resolve;
			rejectPaused = reject;
		});
	};
	enqueue[dropNullSymbol] = true;
	const queue = [];
	const pump = async () => {
		while (queue.length) {
			if (destroyed) throw CANCEL$1;
			let result = queue[queue.length - 1].next();
			if (result && typeof result.then == "function") result = await result;
			if (result.done) {
				queue.pop();
				continue;
			}
			let value = result.value;
			if (value && typeof value.then == "function") value = await value;
			const r = processValue(value);
			if (r) await r;
		}
	};
	const release = async (error) => {
		while (queue.length) {
			const g = queue.pop();
			try {
				if (g.return) await g.return();
			} catch (cleanupErr) {
				error = withCleanupError(error, cleanupErr);
			}
		}
		throw error;
	};
	const processValue = (value) => {
		if (value && typeof value.then == "function") return value.then(processValue);
		if (value == null || value === none) return;
		if (value === stop) throw new Stop();
		if (isMany(value)) {
			const values = getManyValues(value);
			let promise;
			for (let i = 0; i < values.length; ++i) if (promise) {
				const ii = i;
				promise = promise.then(() => processValue(values[ii]));
			} else {
				const r = processValue(values[i]);
				if (r) promise = r;
			}
			return promise;
		}
		if (isFinalValue(value)) return processValue(getFinalValue(value));
		if (value && typeof value.next == "function") {
			queue.push(value);
			return pump().catch(release);
		}
		return enqueue(value);
	};
	const finishWrite = (callback, error) => {
		if (!error || error === CANCEL$1) callback(null);
		else if (!isStop(error)) callback(error);
		else {
			stopped = true;
			finishStop(stages, error, enqueue, finished).then(() => {
				flushed = true;
				signalEnd();
				callback(null);
			}, (failure) => callback(failure));
		}
	};
	stream = new Duplex({
		writableObjectMode: true,
		readableObjectMode: true,
		...options,
		write(chunk, encoding, callback) {
			if (stopped) return callback(null);
			if (innerFns) {
				let r;
				try {
					r = next(chunk, innerFns, 0, enqueue);
				} catch (error) {
					return finishWrite(callback, error);
				}
				if (r && typeof r.then == "function") r.then(() => callback(null), (error) => finishWrite(callback, error));
				else callback(null);
				return;
			}
			let r;
			try {
				r = processValue(fn(chunk, encoding));
			} catch (error) {
				return finishWrite(callback, error);
			}
			if (r) r.then(() => callback(null), (error) => finishWrite(callback, error));
			else callback(null);
		},
		final(callback) {
			const onComplete = () => {
				flushed = true;
				signalEnd();
				callback(null);
			};
			if (stopped) {
				onComplete();
				return;
			}
			if (innerFns) {
				let r;
				try {
					r = flush(innerFns, 0, enqueue, finished);
				} catch (error) {
					return finishWrite(callback, error);
				}
				if (r && typeof r.then == "function") r.then(onComplete, (error) => finishWrite(callback, error));
				else onComplete();
				return;
			}
			if (!isFlushable(fn)) {
				onComplete();
				return;
			}
			let r;
			try {
				const value = fn(none, null);
				r = processValue(noteFinal(value, fn, finished));
			} catch (error) {
				return finishWrite(callback, error);
			}
			if (r) r.then(onComplete, (error) => finishWrite(callback, error));
			else onComplete();
		},
		read() {
			resume();
		},
		destroy(error, callback) {
			stopped = destroyed = true;
			enqueue[cancelSymbol] = CANCEL$1;
			cancelPaused();
			if (flushed || !canAbort) {
				callback(error);
				return;
			}
			abortStages(stages, finished).then((failure) => callback(failure === void 0 ? error : withCleanupError(error, failure)));
		}
	});
	return stream;
};

// node_modules/stream-chain/src/asWebStream.js
const CANCEL = Symbol.for("object-stream.asWebStreamCancel");
const asWebStream = (fn, options) => {
	if (isDuplexWebStream$1(fn) || isReadableWebStream$1(fn) || isWritableWebStream$1(fn)) return fn;
	if (typeof fn !== "function") throw new TypeError("Only a function or Web Streams object is accepted as the first argument");
	const strategy = options?.strategy;
	const readableStrategy = options?.readableStrategy ?? strategy;
	const writableStrategy = options?.writableStrategy ?? strategy;
	const innerFns = isFunctionList(fn) ? fn.fList : null;
	const stages = innerFns ?? [fn];
	const canAbort = hasAborters(stages), finished = /* @__PURE__ */ new Set();
	let stopped = false;
	let cancelled = false;
	let flushed = false;
	let releasing = null;
	let readableClosed = false;
	let writableErrored = false;
	let readableController;
	let writableController;
	let pendingDrain = null;
	let rejectDrain = null;
	const unblockDrain = () => {
		if (!pendingDrain) return;
		const resolve = pendingDrain;
		pendingDrain = rejectDrain = null;
		resolve();
	};
	const cancelDrain = () => {
		if (!rejectDrain) return;
		const reject = rejectDrain;
		pendingDrain = rejectDrain = null;
		reject(CANCEL);
	};
	const closeReadable = () => {
		if (readableClosed) return;
		readableClosed = true;
		readableController.close();
	};
	const errorReadable = (reason) => {
		if (readableClosed) return;
		readableClosed = true;
		readableController.error(reason);
	};
	const errorWritable = (reason) => {
		if (writableErrored || !writableController) return;
		writableErrored = true;
		writableController.error(reason);
	};
	const readable = new ReadableStream({
		start(c) {
			readableController = c;
		},
		pull() {
			unblockDrain();
		},
		cancel(reason) {
			readableClosed = true;
			cancelProducer();
			errorWritable(reason);
			return releaseStages().then(rethrow);
		}
	}, readableStrategy);
	const enqueue = (value) => {
		if (cancelled) throw CANCEL;
		if (readableClosed) return;
		readableController.enqueue(value);
		if (readableController.desiredSize <= 0) return new Promise((resolve, reject) => {
			pendingDrain = resolve;
			rejectDrain = reject;
		});
	};
	enqueue[dropNullSymbol] = true;
	const cancelProducer = () => {
		stopped = cancelled = true;
		enqueue[cancelSymbol] = CANCEL;
		cancelDrain();
	};
	const releaseStages = () => {
		if (flushed || !canAbort) return Promise.resolve(void 0);
		releasing ??= abortStages(stages, finished);
		return releasing;
	};
	const rethrow = (failure) => {
		if (failure !== void 0) throw failure;
	};
	const queue = [];
	const pump = async () => {
		while (queue.length) {
			if (cancelled) throw CANCEL;
			let result = queue[queue.length - 1].next();
			if (result && typeof result.then == "function") result = await result;
			if (result.done) {
				queue.pop();
				continue;
			}
			let value = result.value;
			if (value && typeof value.then == "function") value = await value;
			const r = processValue(value);
			if (r) await r;
		}
	};
	const release = async (error) => {
		while (queue.length) {
			const g = queue.pop();
			try {
				if (g.return) await g.return();
			} catch (cleanupErr) {
				error = withCleanupError(error, cleanupErr);
			}
		}
		throw error;
	};
	const processValue = (value) => {
		if (value && typeof value.then == "function") return value.then(processValue);
		if (value == null || value === none) return;
		if (value === stop) throw new Stop();
		if (isMany(value)) {
			const values = getManyValues(value);
			let promise;
			for (let i = 0; i < values.length; ++i) if (promise) {
				const ii = i;
				promise = promise.then(() => processValue(values[ii]));
			} else {
				const r = processValue(values[i]);
				if (r) promise = r;
			}
			return promise;
		}
		if (isFinalValue(value)) return processValue(getFinalValue(value));
		if (value && typeof value.next == "function") {
			queue.push(value);
			return pump().catch(release);
		}
		return enqueue(value);
	};
	const endAfterStop = async (stop) => {
		stopped = true;
		try {
			await finishStop(stages, stop, enqueue, finished);
		} catch (error) {
			errorReadable(error);
			throw error;
		}
		flushed = true;
		closeReadable();
	};
	return {
		readable,
		writable: new WritableStream({
			start(controller) {
				writableController = controller;
				controller.signal?.addEventListener("abort", cancelProducer);
			},
			async write(chunk) {
				if (stopped) return;
				try {
					if (innerFns) {
						const r = next(chunk, innerFns, 0, enqueue);
						if (r) await r;
						return;
					}
					const r = processValue(fn(chunk));
					if (r) await r;
				} catch (error) {
					if (error === CANCEL) return;
					if (isStop(error)) return endAfterStop(error);
					errorReadable(error);
					const failure = await releaseStages();
					throw failure === void 0 ? error : withCleanupError(error, failure);
				}
			},
			async close() {
				try {
					if (!stopped) {
						if (innerFns) {
							const r = flush(innerFns, 0, enqueue, finished);
							if (r) await r;
						} else if (isFlushable(fn)) {
							const r = processValue(noteFinal(fn(none), fn, finished));
							if (r) await r;
						}
						flushed = true;
					}
				} catch (error) {
					if (isStop(error)) return endAfterStop(error);
					if (error !== CANCEL) {
						errorReadable(error);
						const failure = await releaseStages();
						throw failure === void 0 ? error : withCleanupError(error, failure);
					}
				}
				closeReadable();
			},
			abort(reason) {
				cancelProducer();
				errorReadable(reason);
				return releaseStages().then(rethrow);
			}
		}, writableStrategy)
	};
};

// node_modules/stream-chain/src/dataSource.js
const dataSource = (fn) => {
	if (typeof fn == "function") return fn;
	if (fn) {
		if (typeof fn[Symbol.asyncIterator] == "function") return fn[Symbol.asyncIterator].bind(fn);
		if (typeof fn[Symbol.iterator] == "function") return fn[Symbol.iterator].bind(fn);
	}
	throw new TypeError("The argument should be a function or an iterable object.");
};

// node_modules/stream-chain/src/index.js
const { isReadableWebStream, isWritableWebStream, isDuplexWebStream, isReadableNodeStream, isWritableNodeStream, isDuplexNodeStream } = defs_exports;
const groupFunctions$1 = (output, fn, index, fns) => {
	if (isDuplexNodeStream(fn) || !index && isReadableNodeStream(fn) || index === fns.length - 1 && isWritableNodeStream(fn)) {
		output.push(fn);
		return output;
	}
	if (isDuplexWebStream(fn)) {
		output.push(Duplex.fromWeb(fn, { objectMode: true }));
		return output;
	}
	if (!index && isReadableWebStream(fn)) {
		output.push(Readable.fromWeb(fn, { objectMode: true }));
		return output;
	}
	if (index === fns.length - 1 && isWritableWebStream(fn)) {
		output.push(Writable.fromWeb(fn, { objectMode: true }));
		return output;
	}
	if (typeof fn != "function") throw TypeError("Item #" + index + " is not a proper stream, nor a function.");
	if (!output.length) output.push([]);
	const last = output[output.length - 1];
	if (Array.isArray(last)) last.push(fn);
	else output.push([fn]);
	return output;
};
const produceStreams = (item) => {
	if (Array.isArray(item)) {
		if (!item.length) return null;
		if (item.length == 1) return item[0] && chain$2.asStream(item[0]);
		return chain$2.asStream(
			/** @type {any} */
			chain$2.gen(...item)
		);
	}
	return item;
};
const wrapFunctions = (fn, index, fns) => {
	if (isDuplexNodeStream(fn) || !index && isReadableNodeStream(fn) || index === fns.length - 1 && isWritableNodeStream(fn)) return fn;
	if (isDuplexWebStream(fn)) return Duplex.fromWeb(fn, { objectMode: true });
	if (!index && isReadableWebStream(fn)) return Readable.fromWeb(fn, { objectMode: true });
	if (index === fns.length - 1 && isWritableWebStream(fn)) return Writable.fromWeb(fn, { objectMode: true });
	if (typeof fn == "function") return chain$2.asStream(fn);
	throw TypeError("Item #" + index + " is not a proper stream, nor a function.");
};
const write = (input, chunk, encoding, callback) => {
	let error = null;
	try {
		input.write(chunk, encoding, (e) => callback(e || error));
	} catch (e) {
		error = e;
	}
};
const final = (input, callback) => {
	let error = null;
	try {
		input.end(null, null, (e) => callback(e || error));
	} catch (e) {
		error = e;
	}
};
const read = (output) => {
	output.resume();
};
const chain$2 = (fns, options) => {
	if (!Array.isArray(fns) || !fns.length) throw TypeError("Chain's first argument should be a non-empty array.");
	fns = fns.flat(Infinity).filter((fn) => fn);
	const streams = (options?.noGrouping ? fns.map(wrapFunctions) : fns.map((fn) => isFunctionList(fn) ? getFunctionList(fn) : fn).flat(Infinity).reduce(groupFunctions$1, []).map(produceStreams)).filter((s) => s), input = streams[0], output = streams.reduce((output, item) => output && output.pipe(item) || item);
	let stream = null;
	let writeMethod = (chunk, encoding, callback) => write(input, chunk, encoding, callback), finalMethod = (callback) => final(input, callback), readMethod = () => read(output);
	if (!isWritableNodeStream(input)) {
		writeMethod = (_1, _2, callback) => callback(null);
		finalMethod = (callback) => callback(null);
		input.on("end", () => stream.end());
	}
	if (isReadableNodeStream(output)) {
		output.on("data", (chunk) => !stream.push(chunk) && output.pause());
		output.on("end", () => stream.push(null));
	} else {
		readMethod = () => {};
		output.on("finish", () => stream.push(null));
	}
	stream = new Duplex({
		writableObjectMode: true,
		readableObjectMode: true,
		...options,
		readable: isReadableNodeStream(output),
		writable: isWritableNodeStream(input),
		write: writeMethod,
		final: finalMethod,
		read: readMethod,
		destroy(error, callback) {
			if (!stream.writableFinished || !stream.readableEnded) for (const item of streams) item.destroy();
			callback(error);
		}
	});
	stream.streams = streams;
	stream.input = input;
	stream.output = output;
	if (!isReadableNodeStream(output)) stream.resume();
	if (!options?.skipEvents) streams.forEach((item) => item.on("error", (error) => stream.emit("error", error)));
	return stream;
};
chain$2.none = none;
chain$2.stop = stop;
chain$2.Stop = Stop;
chain$2.stopErrorSymbol = stopErrorSymbol;
chain$2.isStop = isStop;
chain$2.finalSymbol = finalSymbol;
chain$2.finalValue = finalValue;
chain$2.final = final$1;
chain$2.isFinalValue = isFinalValue;
chain$2.getFinalValue = getFinalValue;
chain$2.manySymbol = manySymbol;
chain$2.many = many;
chain$2.isMany = isMany;
chain$2.getManyValues = getManyValues;
chain$2.flushSymbol = flushSymbol;
chain$2.flushable = flushable;
chain$2.isFlushable = isFlushable;
chain$2.abortSymbol = abortSymbol;
chain$2.fListSymbol = fListSymbol;
chain$2.isFunctionList = isFunctionList;
chain$2.getFunctionList = getFunctionList;
chain$2.setFunctionList = setFunctionList;
chain$2.clearFunctionList = clearFunctionList;
chain$2.toMany = toMany;
chain$2.normalizeMany = normalizeMany;
chain$2.combineMany = combineMany;
chain$2.combineManyMut = combineManyMut;
chain$2.chain = chain$2;
chain$2.chainUnchecked = chain$2;
chain$2.gen = gen;
chain$2.asStream = asStream;
chain$2.asWebStream = asWebStream;
chain$2.dataSource = dataSource;

// node_modules/stream-chain/src/fun.js
const asArray = (...fns) => {
	fns = fns.filter((fn) => fn).flat(Infinity).map((fn) => isFunctionList(fn) ? getFunctionList(fn) : fn).flat(Infinity);
	if (!fns.length) fns = [(x) => x];
	let flushed = false, stopAt = 0;
	const noteStop = (error) => {
		if (isStop(error)) stopAt = stopIndex(error, fns);
		throw error;
	};
	let g = (value) => {
		if (flushed) throw Error("Call to a flushed pipe.");
		const results = [], push = (v) => {
			results.push(v);
		};
		let pending;
		if (value !== none) try {
			pending = next(value, fns, 0, push);
		} catch (error) {
			noteStop(error);
		}
		else {
			flushed = true;
			pending = flush(fns, stopAt, push);
		}
		return pending && typeof pending.then == "function" ? pending.then(() => results, noteStop) : results;
	};
	if (fns.some((fn) => isFlushable(fn))) g = flushable(g);
	return setFunctionList(g, fns);
};
const fun = (...fns) => {
	const f = asArray(...fns);
	let g = (value) => {
		const result = f(value);
		if (result && typeof result.then == "function") return result.then((results) => many(results));
		return many(result);
	};
	if (isFlushable(f)) g = flushable(g);
	return setFunctionList(g, getFunctionList(f));
};

// node_modules/stream-chain/src/web/index.js
const groupFunctions = (output, item, index, items) => {
	if (isDuplexWebStream$1(item)) {
		output.push(item);
		return output;
	}
	if (!index && isReadableWebStream$1(item)) {
		output.push({
			readable: item,
			writable: null
		});
		return output;
	}
	if (index === items.length - 1 && isWritableWebStream$1(item)) {
		output.push({
			readable: null,
			writable: item
		});
		return output;
	}
	if (typeof item !== "function") throw new TypeError(`Item #${index} is not a Web Streams object or function.`);
	if (!output.length) output.push([]);
	const last = output[output.length - 1];
	if (Array.isArray(last)) last.push(item);
	else output.push([item]);
	return output;
};
const makeProduceStages = (options) => (item) => {
	if (Array.isArray(item)) {
		if (!item.length) return null;
		if (item.length === 1) return chain$1.asWebStream(item[0], options);
		return chain$1.asWebStream(
			/** @type {any} */
			chain$1.gen(...item),
			options
		);
	}
	return item;
};
const chain$1 = (fns, options) => {
	if (!Array.isArray(fns) || !fns.length) throw new TypeError("Chain's first argument should be a non-empty array.");
	fns = fns.flat(Infinity).filter(Boolean).map((fn) => isFunctionList(fn) ? getFunctionList(fn) : fn).flat(Infinity);
	if (!fns.length) throw new TypeError("Chain's first argument is empty after flattening.");
	const stages = fns.reduce(groupFunctions, []).map(makeProduceStages(options)).filter((s) => s);
	for (let i = 0; i < stages.length - 1; ++i) {
		const from = stages[i].readable;
		const to = stages[i + 1].writable;
		if (!from) throw new TypeError(`Stage #${i} has no readable side; cannot pipe to next stage.`);
		if (!to) throw new TypeError(`Stage #${i + 1} has no writable side; cannot accept input.`);
		from.pipeTo(to).catch(() => {});
	}
	return {
		readable: stages[stages.length - 1].readable,
		writable: stages[0].writable,
		streams: stages,
		input: stages[0],
		output: stages[stages.length - 1]
	};
};
chain$1.none = none;
chain$1.stop = stop;
chain$1.Stop = Stop;
chain$1.stopErrorSymbol = stopErrorSymbol;
chain$1.isStop = isStop;
chain$1.finalSymbol = finalSymbol;
chain$1.finalValue = finalValue;
chain$1.final = final$1;
chain$1.isFinalValue = isFinalValue;
chain$1.getFinalValue = getFinalValue;
chain$1.manySymbol = manySymbol;
chain$1.many = many;
chain$1.isMany = isMany;
chain$1.getManyValues = getManyValues;
chain$1.flushSymbol = flushSymbol;
chain$1.flushable = flushable;
chain$1.isFlushable = isFlushable;
chain$1.abortSymbol = abortSymbol;
chain$1.fListSymbol = fListSymbol;
chain$1.isFunctionList = isFunctionList;
chain$1.getFunctionList = getFunctionList;
chain$1.setFunctionList = setFunctionList;
chain$1.clearFunctionList = clearFunctionList;
chain$1.toMany = toMany;
chain$1.normalizeMany = normalizeMany;
chain$1.combineMany = combineMany;
chain$1.combineManyMut = combineManyMut;
chain$1.chain = chain$1;
chain$1.chainUnchecked = chain$1;
chain$1.gen = gen;
chain$1.fun = fun;
chain$1.asWebStream = asWebStream;
chain$1.dataSource = dataSource;

// node_modules/stream-chain/src/core/index.js
const chain = (fns, _options) => {
	const flat = (Array.isArray(fns) ? fns : []).flat(Infinity).filter(Boolean).map((fn) => isFunctionList(fn) ? getFunctionList(fn) : fn).flat(Infinity);
	const g = gen(...flat);
	const c = async function* (input) {
		if (input == null) return;
		if (typeof input === "string" || input[Symbol.asyncIterator] === void 0 && input[Symbol.iterator] === void 0) {
			yield* g(input);
			return;
		}
		for await (const value of input) yield* g(value);
	};
	c.streams = null;
	c.input = null;
	c.output = null;
	return c;
};
chain.none = none;
chain.stop = stop;
chain.Stop = Stop;
chain.stopErrorSymbol = stopErrorSymbol;
chain.isStop = isStop;
chain.finalSymbol = finalSymbol;
chain.finalValue = finalValue;
chain.final = final$1;
chain.isFinalValue = isFinalValue;
chain.getFinalValue = getFinalValue;
chain.manySymbol = manySymbol;
chain.many = many;
chain.isMany = isMany;
chain.getManyValues = getManyValues;
chain.flushSymbol = flushSymbol;
chain.flushable = flushable;
chain.isFlushable = isFlushable;
chain.abortSymbol = abortSymbol;
chain.fListSymbol = fListSymbol;
chain.isFunctionList = isFunctionList;
chain.getFunctionList = getFunctionList;
chain.setFunctionList = setFunctionList;
chain.clearFunctionList = clearFunctionList;
chain.toMany = toMany;
chain.normalizeMany = normalizeMany;
chain.combineMany = combineMany;
chain.combineManyMut = combineManyMut;
chain.chain = chain;
chain.chainUnchecked = chain;
chain.gen = gen;
chain.fun = fun;
chain.dataSource = dataSource;

// node_modules/stream-chain/src/utils/fixUtf8Stream.js
const dropBOM = (s) => s.charCodeAt(0) === 65279 ? s.slice(1) : s;
const makeTextDecoderImpl = (options) => {
	const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
	let atStart = !options?.ignoreBOM;
	return flushable((chunk) => {
		let s;
		if (chunk === none) s = textDecoder.decode();
		else if (typeof chunk == "string") s = chunk;
		else if (chunk instanceof Uint8Array) s = textDecoder.decode(chunk, { stream: true });
		else throw new TypeError("Expected a string or a Uint8Array");
		if (!atStart || !s) return s;
		atStart = false;
		return dropBOM(s);
	});
};
const makeStringDecoderImpl = (StringDecoder) => (options) => {
	const stringDecoder = new StringDecoder();
	let atStart = !options?.ignoreBOM;
	return flushable((chunk) => {
		let s;
		if (chunk === none) s = stringDecoder.end();
		else if (typeof chunk == "string") s = chunk;
		else if (chunk instanceof Uint8Array) s = stringDecoder.write(chunk);
		else throw new TypeError("Expected a string or a Uint8Array");
		if (!atStart || !s) return s;
		atStart = false;
		return dropBOM(s);
	});
};
let impl = makeTextDecoderImpl;
const isDeno = typeof globalThis["Deno"] == "object" && globalThis["Deno"]?.version;
const isBun = typeof globalThis["Bun"] == "object" && globalThis["Bun"]?.version;
const readyPromise = !isDeno && !isBun && typeof process == "object" && process?.versions?.node ? import("node:string_decoder").then(({ StringDecoder }) => {
	impl = makeStringDecoderImpl(StringDecoder);
}, () => {}) : Promise.resolve();
const fixUtf8Stream = (options) => impl(options);

// node_modules/stream-json/src/core/parser.js
const patterns = {
	value1: /[\"\{\[\]\-\d]|true\b|false\b|null\b|\s{1,256}/y,
	string: /[^\x00-\x1f\"\\]{1,256}|\\[bfnrt\"\\\/]|\\u[\da-fA-F]{4}|\"/y,
	numberStart: /\d/y,
	numberDigit: /\d{0,256}/y,
	numberFraction: /[\.eE]/y,
	numberExponent: /[eE]/y,
	numberExpSign: /[-+]/y
};
const MAX_PATTERN_SIZE = 16;
patterns.numberFracStart = patterns.numberExpStart = patterns.numberStart;
patterns.numberFracDigit = patterns.numberExpDigit = patterns.numberDigit;
const expected = {
	object: "objectStop",
	array: "arrayStop",
	"": "done"
};
const tokenStartObject = { name: "startObject" };
const tokenEndObject = { name: "endObject" };
const tokenStartArray = { name: "startArray" };
const tokenEndArray = { name: "endArray" };
const tokenStartString = { name: "startString" };
const tokenEndString = { name: "endString" };
const tokenStartNumber = { name: "startNumber" };
const tokenEndNumber = { name: "endNumber" };
const tokenStartKey = { name: "startKey" };
const tokenEndKey = { name: "endKey" };
const literalTokens = {
	true: {
		name: "trueValue",
		value: true
	},
	false: {
		name: "falseValue",
		value: false
	},
	null: {
		name: "nullValue",
		value: null
	}
};
const fromHex = (s) => String.fromCharCode(parseInt(s.slice(2), 16));
const codes = {
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "	",
	"\"": "\"",
	"\\": "\\",
	"/": "/"
};
const ASCII_TAB = "	".charCodeAt(0);
const ASCII_LF = "\n".charCodeAt(0);
const ASCII_CR = "\r".charCodeAt(0);
const ASCII_SPACE = " ".charCodeAt(0);
const ASCII_QUOTE = "\"".charCodeAt(0);
const ASCII_BACKSLASH = "\\".charCodeAt(0);
const ASCII_OPEN_BRACE = "{".charCodeAt(0);
const ASCII_CLOSE_BRACE = "}".charCodeAt(0);
const ASCII_OPEN_BRACKET = "[".charCodeAt(0);
const ASCII_CLOSE_BRACKET = "]".charCodeAt(0);
const ASCII_MINUS = "-".charCodeAt(0);
const ASCII_COLON = ":".charCodeAt(0);
const ASCII_COMMA = ",".charCodeAt(0);
const ASCII_ZERO = "0".charCodeAt(0);
const ASCII_NINE = "9".charCodeAt(0);
const ASCII_UPPER_A = "A".charCodeAt(0);
const ASCII_UPPER_F = "F".charCodeAt(0);
const ASCII_LOWER_A = "a".charCodeAt(0);
const ASCII_LOWER_F = "f".charCodeAt(0);
const ASCII_LOWER_N = "n".charCodeAt(0);
const ASCII_LOWER_T = "t".charCodeAt(0);
const ASCII_LOWER_U = "u".charCodeAt(0);
const HIGH_SURROGATE_FIRST = 55296;
const HIGH_SURROGATE_LAST = 56319;
const TERM = [];
for (const ch of ",}] 	\n\r") TERM[ch.charCodeAt(0)] = 1;
const numberFull = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/y;
const HEX = (c) => c >= ASCII_ZERO && c <= ASCII_NINE || c >= ASCII_UPPER_A && c <= ASCII_UPPER_F || c >= ASCII_LOWER_A && c <= ASCII_LOWER_F;
const jsonParser = (options) => {
	let packKeys = true, packStrings = true, packNumbers = true, streamKeys = true, streamStrings = true, streamNumbers = true, jsonStreaming = false;
	if (options) {
		"packValues" in options && (packKeys = packStrings = packNumbers = options.packValues);
		"packKeys" in options && (packKeys = options.packKeys);
		"packStrings" in options && (packStrings = options.packStrings);
		"packNumbers" in options && (packNumbers = options.packNumbers);
		"streamValues" in options && (streamKeys = streamStrings = streamNumbers = options.streamValues);
		"streamKeys" in options && (streamKeys = options.streamKeys);
		"streamStrings" in options && (streamStrings = options.streamStrings);
		"streamNumbers" in options && (streamNumbers = options.streamNumbers);
		jsonStreaming = options.jsonStreaming;
	}
	!packKeys && (streamKeys = true);
	!packStrings && (streamStrings = true);
	!packNumbers && (streamNumbers = true);
	let done = false, expect = jsonStreaming ? "done" : "value", parent = "", openNumber = false, accumulator = "", heldSurrogate = "", buffer = "";
	const stack = [];
	const pushStringChunk = (tokens, value) => {
		if (heldSurrogate) {
			value = heldSurrogate + value;
			heldSurrogate = "";
		}
		const last = value.charCodeAt(value.length - 1);
		if (last >= HIGH_SURROGATE_FIRST && last <= HIGH_SURROGATE_LAST) {
			heldSurrogate = value.charAt(value.length - 1);
			if (value.length === 1) return;
			value = value.slice(0, -1);
		}
		tokens.push({
			name: "stringChunk",
			value
		});
	};
	return flushable((buf) => {
		const tokens = [];
		if (buf === none) done = true;
		else buffer += buf;
		let match, fm, s, e, q, rs, cc, value, index = 0;
		main: for (;;) switch (expect) {
			case "value1":
			case "value":
				while (index < buffer.length) {
					cc = buffer.charCodeAt(index);
					if (cc === ASCII_SPACE || cc === ASCII_TAB || cc === ASCII_LF || cc === ASCII_CR) {
						++index;
						continue;
					}
					break;
				}
				if (index >= buffer.length) {
					if (done) throw new Error("Parser has expected a value");
					break main;
				}
				cc = buffer.charCodeAt(index);
				if (cc === ASCII_QUOTE) {
					q = index + 1;
					rs = q;
					s = "";
					for (;;) {
						if (q >= buffer.length) {
							q = -1;
							break;
						}
						e = buffer.charCodeAt(q);
						if (e === ASCII_QUOTE) {
							s += buffer.slice(rs, q);
							break;
						}
						if (e < ASCII_SPACE) {
							q = -1;
							break;
						}
						if (e === ASCII_BACKSLASH) {
							if (q + 1 >= buffer.length) {
								q = -1;
								break;
							}
							cc = buffer.charCodeAt(q + 1);
							if (cc === ASCII_LOWER_U) {
								if (q + 6 > buffer.length || !(HEX(buffer.charCodeAt(q + 2)) && HEX(buffer.charCodeAt(q + 3)) && HEX(buffer.charCodeAt(q + 4)) && HEX(buffer.charCodeAt(q + 5)))) {
									q = -1;
									break;
								}
								s += buffer.slice(rs, q) + String.fromCharCode(parseInt(buffer.slice(q + 2, q + 6), 16));
								q += 6;
							} else {
								value = codes[buffer.charAt(q + 1)];
								if (value === void 0) {
									q = -1;
									break;
								}
								s += buffer.slice(rs, q) + value;
								q += 2;
							}
							rs = q;
							continue;
						}
						++q;
					}
					if (q >= 0) {
						if (streamStrings) {
							tokens.push(tokenStartString);
							if (s) tokens.push({
								name: "stringChunk",
								value: s
							});
							tokens.push(tokenEndString);
						}
						if (packStrings) tokens.push({
							name: "stringValue",
							value: s
						});
						index = q + 1;
						expect = expected[parent];
						continue main;
					}
					if (streamStrings) tokens.push(tokenStartString);
					expect = "string";
					++index;
					continue main;
				}
				if (cc === ASCII_OPEN_BRACE) {
					tokens.push(tokenStartObject);
					stack.push(parent);
					parent = "object";
					expect = "key1";
					++index;
					continue main;
				}
				if (cc === ASCII_OPEN_BRACKET) {
					tokens.push(tokenStartArray);
					stack.push(parent);
					parent = "array";
					expect = "value1";
					++index;
					continue main;
				}
				if (cc === ASCII_CLOSE_BRACKET) {
					if (expect !== "value1") throw new Error("Parser cannot parse input: unexpected token ']'");
					tokens.push(tokenEndArray);
					parent = stack.pop();
					expect = expected[parent];
					++index;
					continue main;
				}
				if (cc === ASCII_MINUS || cc >= ASCII_ZERO && cc <= ASCII_NINE) {
					numberFull.lastIndex = index;
					fm = numberFull.exec(buffer);
					if (fm) {
						e = index + fm[0].length;
						if (e < buffer.length && TERM[buffer.charCodeAt(e)]) {
							s = fm[0];
							if (streamNumbers) tokens.push(tokenStartNumber, {
								name: "numberChunk",
								value: s
							}, tokenEndNumber);
							if (packNumbers) tokens.push({
								name: "numberValue",
								value: s
							});
							index = e;
							expect = expected[parent];
							continue main;
						}
					}
					openNumber = true;
					if (cc === ASCII_MINUS) {
						if (streamNumbers) tokens.push(tokenStartNumber, {
							name: "numberChunk",
							value: "-"
						});
						packNumbers && (accumulator = "-");
						expect = "numberStart";
					} else if (cc === ASCII_ZERO) {
						if (streamNumbers) tokens.push(tokenStartNumber, {
							name: "numberChunk",
							value: "0"
						});
						packNumbers && (accumulator = "0");
						expect = "numberFraction";
					} else {
						s = buffer.charAt(index);
						if (streamNumbers) tokens.push(tokenStartNumber, {
							name: "numberChunk",
							value: s
						});
						packNumbers && (accumulator = s);
						expect = "numberDigit";
					}
					++index;
					continue main;
				}
				if (cc === ASCII_LOWER_T || cc === ASCII_LOWER_F || cc === ASCII_LOWER_N) {
					patterns.value1.lastIndex = index;
					match = patterns.value1.exec(buffer);
					if (!match) {
						if (done || index + MAX_PATTERN_SIZE < buffer.length) throw new Error("Parser cannot parse input: expected a value");
						break main;
					}
					value = match[0];
					if (buffer.length - index === value.length && !done) break main;
					tokens.push(literalTokens[value]);
					expect = expected[parent];
					index += value.length;
					continue main;
				}
				throw new Error("Parser cannot parse input: expected a value");
			case "keyVal":
			case "string":
				patterns.string.lastIndex = index;
				match = patterns.string.exec(buffer);
				if (!match) {
					if (index < buffer.length && (done || buffer.length - index >= 6)) throw new Error("Parser cannot parse input: escaped characters");
					if (done) throw new Error("Parser has expected a string value");
					break main;
				}
				value = match[0];
				if (value === "\"") {
					if (heldSurrogate) {
						tokens.push({
							name: "stringChunk",
							value: heldSurrogate
						});
						heldSurrogate = "";
					}
					if (expect === "keyVal") {
						if (streamKeys) tokens.push(tokenEndKey);
						if (packKeys) {
							tokens.push({
								name: "keyValue",
								value: accumulator
							});
							accumulator = "";
						}
						expect = "colon";
					} else {
						if (streamStrings) tokens.push(tokenEndString);
						if (packStrings) {
							tokens.push({
								name: "stringValue",
								value: accumulator
							});
							accumulator = "";
						}
						expect = expected[parent];
					}
				} else if (value.length > 1 && value.charAt(0) === "\\") {
					const t = value.length == 2 ? codes[value.charAt(1)] : fromHex(value);
					if (expect === "keyVal" ? streamKeys : streamStrings) pushStringChunk(tokens, t);
					if (expect === "keyVal" ? packKeys : packStrings) accumulator += t;
				} else {
					if (expect === "keyVal" ? streamKeys : streamStrings) pushStringChunk(tokens, value);
					if (expect === "keyVal" ? packKeys : packStrings) accumulator += value;
				}
				index += value.length;
				break;
			case "key1":
			case "key":
				while (index < buffer.length) {
					cc = buffer.charCodeAt(index);
					if (cc === ASCII_SPACE || cc === ASCII_TAB || cc === ASCII_LF || cc === ASCII_CR) {
						++index;
						continue;
					}
					break;
				}
				if (index >= buffer.length) {
					if (done) throw new Error("Parser cannot parse input: expected an object key");
					break main;
				}
				cc = buffer.charCodeAt(index);
				if (cc === ASCII_QUOTE) {
					q = index + 1;
					rs = q;
					s = "";
					for (;;) {
						if (q >= buffer.length) {
							q = -1;
							break;
						}
						e = buffer.charCodeAt(q);
						if (e === ASCII_QUOTE) {
							s += buffer.slice(rs, q);
							break;
						}
						if (e < ASCII_SPACE) {
							q = -1;
							break;
						}
						if (e === ASCII_BACKSLASH) {
							if (q + 1 >= buffer.length) {
								q = -1;
								break;
							}
							cc = buffer.charCodeAt(q + 1);
							if (cc === ASCII_LOWER_U) {
								if (q + 6 > buffer.length || !(HEX(buffer.charCodeAt(q + 2)) && HEX(buffer.charCodeAt(q + 3)) && HEX(buffer.charCodeAt(q + 4)) && HEX(buffer.charCodeAt(q + 5)))) {
									q = -1;
									break;
								}
								s += buffer.slice(rs, q) + String.fromCharCode(parseInt(buffer.slice(q + 2, q + 6), 16));
								q += 6;
							} else {
								value = codes[buffer.charAt(q + 1)];
								if (value === void 0) {
									q = -1;
									break;
								}
								s += buffer.slice(rs, q) + value;
								q += 2;
							}
							rs = q;
							continue;
						}
						++q;
					}
					if (q >= 0) {
						if (streamKeys) {
							tokens.push(tokenStartKey);
							if (s) tokens.push({
								name: "stringChunk",
								value: s
							});
							tokens.push(tokenEndKey);
						}
						if (packKeys) tokens.push({
							name: "keyValue",
							value: s
						});
						index = q + 1;
						expect = "colon";
						continue main;
					}
					if (streamKeys) tokens.push(tokenStartKey);
					expect = "keyVal";
					++index;
					continue main;
				}
				if (cc === ASCII_CLOSE_BRACE) {
					if (expect !== "key1") throw new Error("Parser cannot parse input: unexpected token '}'");
					tokens.push(tokenEndObject);
					parent = stack.pop();
					expect = expected[parent];
					++index;
					continue main;
				}
				throw new Error("Parser cannot parse input: expected an object key");
			case "colon":
				while (index < buffer.length) {
					cc = buffer.charCodeAt(index);
					if (cc === ASCII_SPACE || cc === ASCII_TAB || cc === ASCII_LF || cc === ASCII_CR) {
						++index;
						continue;
					}
					break;
				}
				if (index >= buffer.length) {
					if (done) throw new Error("Parser cannot parse input: expected ':'");
					break main;
				}
				cc = buffer.charCodeAt(index);
				if (cc === ASCII_COLON) {
					expect = "value";
					++index;
					continue main;
				}
				throw new Error("Parser cannot parse input: expected ':'");
			case "arrayStop":
			case "objectStop":
				while (index < buffer.length) {
					cc = buffer.charCodeAt(index);
					if (cc === ASCII_SPACE || cc === ASCII_TAB || cc === ASCII_LF || cc === ASCII_CR) {
						++index;
						continue;
					}
					break;
				}
				if (index >= buffer.length) {
					if (done) throw new Error("Parser cannot parse input: expected ','");
					break main;
				}
				if (openNumber) {
					if (streamNumbers) tokens.push(tokenEndNumber);
					openNumber = false;
					if (packNumbers) {
						tokens.push({
							name: "numberValue",
							value: accumulator
						});
						accumulator = "";
					}
				}
				cc = buffer.charCodeAt(index);
				if (cc === ASCII_COMMA) {
					expect = expect === "arrayStop" ? "value" : "key";
					++index;
					continue main;
				}
				if (cc === ASCII_CLOSE_BRACE || cc === ASCII_CLOSE_BRACKET) {
					if (cc === ASCII_CLOSE_BRACE ? expect === "arrayStop" : expect !== "arrayStop") throw new Error("Parser cannot parse input: expected '" + (expect === "arrayStop" ? "]" : "}") + "'");
					tokens.push(cc === ASCII_CLOSE_BRACE ? tokenEndObject : tokenEndArray);
					parent = stack.pop();
					expect = expected[parent];
					++index;
					continue main;
				}
				throw new Error("Parser cannot parse input: expected ','");
			case "numberStart":
				patterns.numberStart.lastIndex = index;
				match = patterns.numberStart.exec(buffer);
				if (!match) {
					if (index < buffer.length || done) throw new Error("Parser cannot parse input: expected a starting digit");
					break main;
				}
				value = match[0];
				if (streamNumbers) tokens.push({
					name: "numberChunk",
					value
				});
				packNumbers && (accumulator += value);
				expect = value === "0" ? "numberFraction" : "numberDigit";
				index += value.length;
				break;
			case "numberDigit":
				patterns.numberDigit.lastIndex = index;
				match = patterns.numberDigit.exec(buffer);
				if (!match) {
					if (index < buffer.length || done) throw new Error("Parser cannot parse input: expected a digit");
					break main;
				}
				value = match[0];
				if (value) {
					if (streamNumbers) tokens.push({
						name: "numberChunk",
						value
					});
					packNumbers && (accumulator += value);
					index += value.length;
				} else {
					if (index < buffer.length) {
						expect = "numberFraction";
						break;
					}
					if (done) {
						expect = expected[parent];
						break;
					}
					break main;
				}
				break;
			case "numberFraction":
				patterns.numberFraction.lastIndex = index;
				match = patterns.numberFraction.exec(buffer);
				if (!match) {
					if (index < buffer.length || done) {
						expect = expected[parent];
						break;
					}
					break main;
				}
				value = match[0];
				if (streamNumbers) tokens.push({
					name: "numberChunk",
					value
				});
				packNumbers && (accumulator += value);
				expect = value === "." ? "numberFracStart" : "numberExpSign";
				index += value.length;
				break;
			case "numberFracStart":
				patterns.numberFracStart.lastIndex = index;
				match = patterns.numberFracStart.exec(buffer);
				if (!match) {
					if (index < buffer.length || done) throw new Error("Parser cannot parse input: expected a fractional part of a number");
					break main;
				}
				value = match[0];
				if (streamNumbers) tokens.push({
					name: "numberChunk",
					value
				});
				packNumbers && (accumulator += value);
				expect = "numberFracDigit";
				index += value.length;
				break;
			case "numberFracDigit":
				patterns.numberFracDigit.lastIndex = index;
				match = patterns.numberFracDigit.exec(buffer);
				value = match[0];
				if (value) {
					if (streamNumbers) tokens.push({
						name: "numberChunk",
						value
					});
					packNumbers && (accumulator += value);
					index += value.length;
				} else {
					if (index < buffer.length) {
						expect = "numberExponent";
						break;
					}
					if (done) {
						expect = expected[parent];
						break;
					}
					break main;
				}
				break;
			case "numberExponent":
				patterns.numberExponent.lastIndex = index;
				match = patterns.numberExponent.exec(buffer);
				if (!match) {
					if (index < buffer.length) {
						expect = expected[parent];
						break;
					}
					if (done) {
						expect = expected[parent];
						break;
					}
					break main;
				}
				value = match[0];
				if (streamNumbers) tokens.push({
					name: "numberChunk",
					value
				});
				packNumbers && (accumulator += value);
				expect = "numberExpSign";
				index += value.length;
				break;
			case "numberExpSign":
				patterns.numberExpSign.lastIndex = index;
				match = patterns.numberExpSign.exec(buffer);
				if (!match) {
					if (index < buffer.length) {
						expect = "numberExpStart";
						break;
					}
					if (done) throw new Error("Parser has expected an exponent value of a number");
					break main;
				}
				value = match[0];
				if (streamNumbers) tokens.push({
					name: "numberChunk",
					value
				});
				packNumbers && (accumulator += value);
				expect = "numberExpStart";
				index += value.length;
				break;
			case "numberExpStart":
				patterns.numberExpStart.lastIndex = index;
				match = patterns.numberExpStart.exec(buffer);
				if (!match) {
					if (index < buffer.length || done) throw new Error("Parser cannot parse input: expected an exponent part of a number");
					break main;
				}
				value = match[0];
				if (streamNumbers) tokens.push({
					name: "numberChunk",
					value
				});
				packNumbers && (accumulator += value);
				expect = "numberExpDigit";
				index += value.length;
				break;
			case "numberExpDigit":
				patterns.numberExpDigit.lastIndex = index;
				match = patterns.numberExpDigit.exec(buffer);
				value = match[0];
				if (value) {
					if (streamNumbers) tokens.push({
						name: "numberChunk",
						value
					});
					packNumbers && (accumulator += value);
					index += value.length;
				} else {
					if (index < buffer.length || done) {
						expect = expected[parent];
						break;
					}
					break main;
				}
				break;
			case "done":
				while (index < buffer.length) {
					cc = buffer.charCodeAt(index);
					if (cc === ASCII_SPACE || cc === ASCII_TAB || cc === ASCII_LF || cc === ASCII_CR) {
						if (openNumber) {
							if (streamNumbers) tokens.push(tokenEndNumber);
							openNumber = false;
							if (packNumbers) {
								tokens.push({
									name: "numberValue",
									value: accumulator
								});
								accumulator = "";
							}
						}
						++index;
						continue;
					}
					break;
				}
				if (index >= buffer.length) break main;
				if (jsonStreaming) {
					if (openNumber) {
						if (streamNumbers) tokens.push(tokenEndNumber);
						openNumber = false;
						if (packNumbers) {
							tokens.push({
								name: "numberValue",
								value: accumulator
							});
							accumulator = "";
						}
					}
					expect = "value";
					continue main;
				}
				throw new Error("Parser cannot parse input: unexpected characters");
		}
		if (done && openNumber) {
			if (streamNumbers) tokens.push(tokenEndNumber);
			openNumber = false;
			if (packNumbers) {
				tokens.push({
					name: "numberValue",
					value: accumulator
				});
				accumulator = "";
			}
		}
		buffer = buffer.slice(index);
		return tokens.length ? many(tokens) : none;
	});
};
const parser = (options) => gen(fixUtf8Stream(options), jsonParser(options));
parser.parser = parser;

// node_modules/stream-json/src/parser.js
/** @type {any} */ parser.asStream = (options) => asStream(parser(options), {
	writableObjectMode: true,
	readableObjectMode: true,
	...options
});
/** @type {any} */ parser.asWebStream = (options) => asWebStream(parser(options), {
	writableObjectMode: true,
	readableObjectMode: true,
	...options
});
var parser_default = parser;

// node_modules/yaml/dist/nodes/identity.js
var require_identity = /* @__PURE__ */ __commonJSMin(((exports) => {
	const ALIAS = Symbol.for("yaml.alias");
	const DOC = Symbol.for("yaml.document");
	const MAP = Symbol.for("yaml.map");
	const PAIR = Symbol.for("yaml.pair");
	const SCALAR = Symbol.for("yaml.scalar");
	const SEQ = Symbol.for("yaml.seq");
	const NODE_TYPE = Symbol.for("yaml.node.type");
	const isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
	const isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
	const isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
	const isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
	const isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
	const isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
	function isCollection(node) {
		if (node && typeof node === "object") switch (node[NODE_TYPE]) {
			case MAP:
			case SEQ: return true;
		}
		return false;
	}
	function isNode(node) {
		if (node && typeof node === "object") switch (node[NODE_TYPE]) {
			case ALIAS:
			case MAP:
			case SCALAR:
			case SEQ: return true;
		}
		return false;
	}
	const hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
	exports.ALIAS = ALIAS;
	exports.DOC = DOC;
	exports.MAP = MAP;
	exports.NODE_TYPE = NODE_TYPE;
	exports.PAIR = PAIR;
	exports.SCALAR = SCALAR;
	exports.SEQ = SEQ;
	exports.hasAnchor = hasAnchor;
	exports.isAlias = isAlias;
	exports.isCollection = isCollection;
	exports.isDocument = isDocument;
	exports.isMap = isMap;
	exports.isNode = isNode;
	exports.isPair = isPair;
	exports.isScalar = isScalar;
	exports.isSeq = isSeq;
}));

// node_modules/yaml/dist/visit.js
var require_visit = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	const BREAK = Symbol("break visit");
	const SKIP = Symbol("skip children");
	const REMOVE = Symbol("remove node");
	/**
	* Apply a visitor to an AST node or document.
	*
	* Walks through the tree (depth-first) starting from `node`, calling a
	* `visitor` function with three arguments:
	*   - `key`: For sequence values and map `Pair`, the node's index in the
	*     collection. Within a `Pair`, `'key'` or `'value'`, correspondingly.
	*     `null` for the root node.
	*   - `node`: The current node.
	*   - `path`: The ancestry of the current node.
	*
	* The return value of the visitor may be used to control the traversal:
	*   - `undefined` (default): Do nothing and continue
	*   - `visit.SKIP`: Do not visit the children of this node, continue with next
	*     sibling
	*   - `visit.BREAK`: Terminate traversal completely
	*   - `visit.REMOVE`: Remove the current node, then continue with the next one
	*   - `Node`: Replace the current node, then continue by visiting it
	*   - `number`: While iterating the items of a sequence or map, set the index
	*     of the next step. This is useful especially if the index of the current
	*     node has changed.
	*
	* If `visitor` is a single function, it will be called with all values
	* encountered in the tree, including e.g. `null` values. Alternatively,
	* separate visitor functions may be defined for each `Map`, `Pair`, `Seq`,
	* `Alias` and `Scalar` node. To define the same visitor function for more than
	* one node type, use the `Collection` (map and seq), `Value` (map, seq & scalar)
	* and `Node` (alias, map, seq & scalar) targets. Of all these, only the most
	* specific defined one will be used for each node.
	*/
	function visit(node, visitor) {
		const visitor_ = initVisitor(visitor);
		if (identity.isDocument(node)) {
			if (visit_(null, node.contents, visitor_, Object.freeze([node])) === REMOVE) node.contents = null;
		} else visit_(null, node, visitor_, Object.freeze([]));
	}
	/** Terminate visit traversal completely */
	visit.BREAK = BREAK;
	/** Do not visit the children of the current node */
	visit.SKIP = SKIP;
	/** Remove the current node */
	visit.REMOVE = REMOVE;
	function visit_(key, node, visitor, path) {
		const ctrl = callVisitor(key, node, visitor, path);
		if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
			replaceNode(key, path, ctrl);
			return visit_(key, ctrl, visitor, path);
		}
		if (typeof ctrl !== "symbol") {
			if (identity.isCollection(node)) {
				path = Object.freeze(path.concat(node));
				for (let i = 0; i < node.items.length; ++i) {
					const ci = visit_(i, node.items[i], visitor, path);
					if (typeof ci === "number") i = ci - 1;
					else if (ci === BREAK) return BREAK;
					else if (ci === REMOVE) {
						node.items.splice(i, 1);
						i -= 1;
					}
				}
			} else if (identity.isPair(node)) {
				path = Object.freeze(path.concat(node));
				const ck = visit_("key", node.key, visitor, path);
				if (ck === BREAK) return BREAK;
				else if (ck === REMOVE) node.key = null;
				const cv = visit_("value", node.value, visitor, path);
				if (cv === BREAK) return BREAK;
				else if (cv === REMOVE) node.value = null;
			}
		}
		return ctrl;
	}
	/**
	* Apply an async visitor to an AST node or document.
	*
	* Walks through the tree (depth-first) starting from `node`, calling a
	* `visitor` function with three arguments:
	*   - `key`: For sequence values and map `Pair`, the node's index in the
	*     collection. Within a `Pair`, `'key'` or `'value'`, correspondingly.
	*     `null` for the root node.
	*   - `node`: The current node.
	*   - `path`: The ancestry of the current node.
	*
	* The return value of the visitor may be used to control the traversal:
	*   - `Promise`: Must resolve to one of the following values
	*   - `undefined` (default): Do nothing and continue
	*   - `visit.SKIP`: Do not visit the children of this node, continue with next
	*     sibling
	*   - `visit.BREAK`: Terminate traversal completely
	*   - `visit.REMOVE`: Remove the current node, then continue with the next one
	*   - `Node`: Replace the current node, then continue by visiting it
	*   - `number`: While iterating the items of a sequence or map, set the index
	*     of the next step. This is useful especially if the index of the current
	*     node has changed.
	*
	* If `visitor` is a single function, it will be called with all values
	* encountered in the tree, including e.g. `null` values. Alternatively,
	* separate visitor functions may be defined for each `Map`, `Pair`, `Seq`,
	* `Alias` and `Scalar` node. To define the same visitor function for more than
	* one node type, use the `Collection` (map and seq), `Value` (map, seq & scalar)
	* and `Node` (alias, map, seq & scalar) targets. Of all these, only the most
	* specific defined one will be used for each node.
	*/
	async function visitAsync(node, visitor) {
		const visitor_ = initVisitor(visitor);
		if (identity.isDocument(node)) {
			if (await visitAsync_(null, node.contents, visitor_, Object.freeze([node])) === REMOVE) node.contents = null;
		} else await visitAsync_(null, node, visitor_, Object.freeze([]));
	}
	/** Terminate visit traversal completely */
	visitAsync.BREAK = BREAK;
	/** Do not visit the children of the current node */
	visitAsync.SKIP = SKIP;
	/** Remove the current node */
	visitAsync.REMOVE = REMOVE;
	async function visitAsync_(key, node, visitor, path) {
		const ctrl = await callVisitor(key, node, visitor, path);
		if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
			replaceNode(key, path, ctrl);
			return visitAsync_(key, ctrl, visitor, path);
		}
		if (typeof ctrl !== "symbol") {
			if (identity.isCollection(node)) {
				path = Object.freeze(path.concat(node));
				for (let i = 0; i < node.items.length; ++i) {
					const ci = await visitAsync_(i, node.items[i], visitor, path);
					if (typeof ci === "number") i = ci - 1;
					else if (ci === BREAK) return BREAK;
					else if (ci === REMOVE) {
						node.items.splice(i, 1);
						i -= 1;
					}
				}
			} else if (identity.isPair(node)) {
				path = Object.freeze(path.concat(node));
				const ck = await visitAsync_("key", node.key, visitor, path);
				if (ck === BREAK) return BREAK;
				else if (ck === REMOVE) node.key = null;
				const cv = await visitAsync_("value", node.value, visitor, path);
				if (cv === BREAK) return BREAK;
				else if (cv === REMOVE) node.value = null;
			}
		}
		return ctrl;
	}
	function initVisitor(visitor) {
		if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) return Object.assign({
			Alias: visitor.Node,
			Map: visitor.Node,
			Scalar: visitor.Node,
			Seq: visitor.Node
		}, visitor.Value && {
			Map: visitor.Value,
			Scalar: visitor.Value,
			Seq: visitor.Value
		}, visitor.Collection && {
			Map: visitor.Collection,
			Seq: visitor.Collection
		}, visitor);
		return visitor;
	}
	function callVisitor(key, node, visitor, path) {
		if (typeof visitor === "function") return visitor(key, node, path);
		if (identity.isMap(node)) return visitor.Map?.(key, node, path);
		if (identity.isSeq(node)) return visitor.Seq?.(key, node, path);
		if (identity.isPair(node)) return visitor.Pair?.(key, node, path);
		if (identity.isScalar(node)) return visitor.Scalar?.(key, node, path);
		if (identity.isAlias(node)) return visitor.Alias?.(key, node, path);
	}
	function replaceNode(key, path, node) {
		const parent = path[path.length - 1];
		if (identity.isCollection(parent)) parent.items[key] = node;
		else if (identity.isPair(parent)) {
			if (key === "key") parent.key = node;
			else parent.value = node;
		} else if (identity.isDocument(parent)) parent.contents = node;
		else {
			const pt = identity.isAlias(parent) ? "alias" : "scalar";
			throw new Error(`Cannot replace node with ${pt} parent`);
		}
	}
	exports.visit = visit;
	exports.visitAsync = visitAsync;
}));

// node_modules/yaml/dist/doc/directives.js
var require_directives = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var visit = require_visit();
	const escapeChars = {
		"!": "%21",
		",": "%2C",
		"[": "%5B",
		"]": "%5D",
		"{": "%7B",
		"}": "%7D"
	};
	const escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
	var Directives = class Directives {
		constructor(yaml, tags) {
			/**
			* The directives-end/doc-start marker `---`. If `null`, a marker may still be
			* included in the document's stringified representation.
			*/
			this.docStart = null;
			/** The doc-end marker `...`.  */
			this.docEnd = false;
			this.yaml = Object.assign({}, Directives.defaultYaml, yaml);
			this.tags = Object.assign({}, Directives.defaultTags, tags);
		}
		clone() {
			const copy = new Directives(this.yaml, this.tags);
			copy.docStart = this.docStart;
			return copy;
		}
		/**
		* During parsing, get a Directives instance for the current document and
		* update the stream state according to the current version's spec.
		*/
		atDocument() {
			const res = new Directives(this.yaml, this.tags);
			switch (this.yaml.version) {
				case "1.1":
					this.atNextDocument = true;
					break;
				case "1.2":
					this.atNextDocument = false;
					this.yaml = {
						explicit: Directives.defaultYaml.explicit,
						version: "1.2"
					};
					this.tags = Object.assign({}, Directives.defaultTags);
			}
			return res;
		}
		/**
		* @param onError - May be called even if the action was successful
		* @returns `true` on success
		*/
		add(line, onError) {
			if (this.atNextDocument) {
				this.yaml = {
					explicit: Directives.defaultYaml.explicit,
					version: "1.1"
				};
				this.tags = Object.assign({}, Directives.defaultTags);
				this.atNextDocument = false;
			}
			const parts = line.trim().split(/[ \t]+/);
			const name = parts.shift();
			switch (name) {
				case "%TAG": {
					if (parts.length !== 2) {
						onError(0, "%TAG directive should contain exactly two parts");
						if (parts.length < 2) return false;
					}
					const [handle, prefix] = parts;
					this.tags[handle] = prefix;
					return true;
				}
				case "%YAML": {
					this.yaml.explicit = true;
					if (parts.length !== 1) {
						onError(0, "%YAML directive should contain exactly one part");
						return false;
					}
					const [version] = parts;
					if (version === "1.1" || version === "1.2") {
						this.yaml.version = version;
						return true;
					} else {
						const isValid = /^\d+\.\d+$/.test(version);
						onError(6, `Unsupported YAML version ${version}`, isValid);
						return false;
					}
				}
				default:
					onError(0, `Unknown directive ${name}`, true);
					return false;
			}
		}
		/**
		* Resolves a tag, matching handles to those defined in %TAG directives.
		*
		* @returns Resolved tag, which may also be the non-specific tag `'!'` or a
		*   `'!local'` tag, or `null` if unresolvable.
		*/
		tagName(source, onError) {
			if (source === "!") return "!";
			if (source[0] !== "!") {
				onError(`Not a valid tag: ${source}`);
				return null;
			}
			if (source[1] === "<") {
				const verbatim = source.slice(2, -1);
				if (verbatim === "!" || verbatim === "!!") {
					onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
					return null;
				}
				if (source[source.length - 1] !== ">") onError("Verbatim tags must end with a >");
				return verbatim;
			}
			const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
			if (!suffix) onError(`The ${source} tag has no suffix`);
			const prefix = this.tags[handle];
			if (prefix) try {
				return prefix + decodeURIComponent(suffix);
			} catch (error) {
				onError(String(error));
				return null;
			}
			if (handle === "!") return source;
			onError(`Could not resolve tag: ${source}`);
			return null;
		}
		/**
		* Given a fully resolved tag, returns its printable string form,
		* taking into account current tag prefixes and defaults.
		*/
		tagString(tag) {
			for (const [handle, prefix] of Object.entries(this.tags)) if (tag.startsWith(prefix)) return handle + escapeTagName(tag.substring(prefix.length));
			return tag[0] === "!" ? tag : `!<${tag}>`;
		}
		toString(doc) {
			const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
			const tagEntries = Object.entries(this.tags);
			let tagNames;
			if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
				const tags = {};
				visit.visit(doc.contents, (_key, node) => {
					if (identity.isNode(node) && node.tag) tags[node.tag] = true;
				});
				tagNames = Object.keys(tags);
			} else tagNames = [];
			for (const [handle, prefix] of tagEntries) {
				if (handle === "!!" && prefix === "tag:yaml.org,2002:") continue;
				if (!doc || tagNames.some((tn) => tn.startsWith(prefix))) lines.push(`%TAG ${handle} ${prefix}`);
			}
			return lines.join("\n");
		}
	};
	Directives.defaultYaml = {
		explicit: false,
		version: "1.2"
	};
	Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
	exports.Directives = Directives;
}));

// node_modules/yaml/dist/doc/anchors.js
var require_anchors = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var visit = require_visit();
	/**
	* Verify that the input string is a valid anchor.
	*
	* Will throw on errors.
	*/
	function anchorIsValid(anchor) {
		if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
			const msg = `Anchor must not contain whitespace or control characters: ${JSON.stringify(anchor)}`;
			throw new Error(msg);
		}
		return true;
	}
	function anchorNames(root) {
		const anchors = /* @__PURE__ */ new Set();
		visit.visit(root, { Value(_key, node) {
			if (node.anchor) anchors.add(node.anchor);
		} });
		return anchors;
	}
	/** Find a new anchor name with the given `prefix` and a one-indexed suffix. */
	function findNewAnchor(prefix, exclude) {
		for (let i = 1;; ++i) {
			const name = `${prefix}${i}`;
			if (!exclude.has(name)) return name;
		}
	}
	function createNodeAnchors(doc, prefix) {
		const aliasObjects = [];
		const sourceObjects = /* @__PURE__ */ new Map();
		let prevAnchors = null;
		return {
			onAnchor: (source) => {
				aliasObjects.push(source);
				prevAnchors ?? (prevAnchors = anchorNames(doc));
				const anchor = findNewAnchor(prefix, prevAnchors);
				prevAnchors.add(anchor);
				return anchor;
			},
			/**
			* With circular references, the source node is only resolved after all
			* of its child nodes are. This is why anchors are set only after all of
			* the nodes have been created.
			*/
			setAnchors: () => {
				for (const source of aliasObjects) {
					const ref = sourceObjects.get(source);
					if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) ref.node.anchor = ref.anchor;
					else {
						const error = /* @__PURE__ */ new Error("Failed to resolve repeated object (this should not happen)");
						error.source = source;
						throw error;
					}
				}
			},
			sourceObjects
		};
	}
	exports.anchorIsValid = anchorIsValid;
	exports.anchorNames = anchorNames;
	exports.createNodeAnchors = createNodeAnchors;
	exports.findNewAnchor = findNewAnchor;
}));

// node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Applies the JSON.parse reviver algorithm as defined in the ECMA-262 spec,
	* in section 24.5.1.1 "Runtime Semantics: InternalizeJSONProperty" of the
	* 2021 edition: https://tc39.es/ecma262/#sec-json.parse
	*
	* Includes extensions for handling Map and Set objects.
	*/
	function applyReviver(reviver, obj, key, val) {
		if (val && typeof val === "object") {
			if (Array.isArray(val)) for (let i = 0, len = val.length; i < len; ++i) {
				const v0 = val[i];
				const v1 = applyReviver(reviver, val, String(i), v0);
				if (v1 === void 0) delete val[i];
				else if (v1 !== v0) val[i] = v1;
			}
			else if (val instanceof Map) for (const k of Array.from(val.keys())) {
				const v0 = val.get(k);
				const v1 = applyReviver(reviver, val, k, v0);
				if (v1 === void 0) val.delete(k);
				else if (v1 !== v0) val.set(k, v1);
			}
			else if (val instanceof Set) for (const v0 of Array.from(val)) {
				const v1 = applyReviver(reviver, val, v0, v0);
				if (v1 === void 0) val.delete(v0);
				else if (v1 !== v0) {
					val.delete(v0);
					val.add(v1);
				}
			}
			else for (const [k, v0] of Object.entries(val)) {
				const v1 = applyReviver(reviver, val, k, v0);
				if (v1 === void 0) delete val[k];
				else if (v1 !== v0) val[k] = v1;
			}
		}
		return reviver.call(obj, key, val);
	}
	exports.applyReviver = applyReviver;
}));

// node_modules/yaml/dist/nodes/toJS.js
var require_toJS = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	/**
	* Recursively convert any node or its contents to native JavaScript
	*
	* @param value - The input value
	* @param arg - If `value` defines a `toJSON()` method, use this
	*   as its first argument
	* @param ctx - Conversion context, originally set in Document#toJS(). If
	*   `{ keep: true }` is not set, output should be suitable for JSON
	*   stringification.
	*/
	function toJS(value, arg, ctx) {
		if (Array.isArray(value)) return value.map((v, i) => toJS(v, String(i), ctx));
		if (value && typeof value.toJSON === "function") {
			if (!ctx || !identity.hasAnchor(value)) return value.toJSON(arg, ctx);
			const data = {
				aliasCount: 0,
				count: 1,
				res: void 0
			};
			ctx.anchors.set(value, data);
			ctx.onCreate = (res) => {
				data.res = res;
				delete ctx.onCreate;
			};
			const res = value.toJSON(arg, ctx);
			if (ctx.onCreate) ctx.onCreate(res);
			return res;
		}
		if (typeof value === "bigint" && !ctx?.keep) return Number(value);
		return value;
	}
	exports.toJS = toJS;
}));

// node_modules/yaml/dist/nodes/Node.js
var require_Node = /* @__PURE__ */ __commonJSMin(((exports) => {
	var applyReviver = require_applyReviver();
	var identity = require_identity();
	var toJS = require_toJS();
	var NodeBase = class {
		constructor(type) {
			Object.defineProperty(this, identity.NODE_TYPE, { value: type });
		}
		/** Create a copy of this node.  */
		clone() {
			const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
			if (this.range) copy.range = this.range.slice();
			return copy;
		}
		/** A plain JavaScript representation of this node. */
		toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
			if (!identity.isDocument(doc)) throw new TypeError("A document argument is required");
			const ctx = {
				anchors: /* @__PURE__ */ new Map(),
				doc,
				keep: true,
				mapAsMap: mapAsMap === true,
				mapKeyWarned: false,
				maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
			};
			const res = toJS.toJS(this, "", ctx);
			if (typeof onAnchor === "function") for (const { count, res } of ctx.anchors.values()) onAnchor(res, count);
			return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
		}
	};
	exports.NodeBase = NodeBase;
}));

// node_modules/yaml/dist/nodes/Alias.js
var require_Alias = /* @__PURE__ */ __commonJSMin(((exports) => {
	var anchors = require_anchors();
	var visit = require_visit();
	var identity = require_identity();
	var Node = require_Node();
	var toJS = require_toJS();
	var Alias = class extends Node.NodeBase {
		constructor(source) {
			super(identity.ALIAS);
			this.source = source;
			Object.defineProperty(this, "tag", { set() {
				throw new Error("Alias nodes cannot have tags");
			} });
		}
		/**
		* Resolve the value of this alias within `doc`, finding the last
		* instance of the `source` anchor before this node.
		*/
		resolve(doc, ctx) {
			if (ctx?.maxAliasCount === 0) throw new ReferenceError("Alias resolution is disabled");
			let nodes;
			if (ctx?.aliasResolveCache) nodes = ctx.aliasResolveCache;
			else {
				nodes = [];
				visit.visit(doc, { Node: (_key, node) => {
					if (identity.isAlias(node) || identity.hasAnchor(node)) nodes.push(node);
				} });
				if (ctx) ctx.aliasResolveCache = nodes;
			}
			let found = void 0;
			for (const node of nodes) {
				if (node === this) break;
				if (node.anchor === this.source) found = node;
			}
			if (found && ctx) {
				const { anchors, doc, maxAliasCount } = ctx;
				let data = anchors.get(found);
				if (!data) {
					toJS.toJS(found, null, ctx);
					data = anchors.get(found);
				}
				/* istanbul ignore if */
				if (data?.res === void 0) throw new ReferenceError("This should not happen: Alias anchor was not resolved?");
				if (maxAliasCount >= 0) {
					data.count += 1;
					if (data.aliasCount === 0) data.aliasCount = getAliasCount(doc, found, anchors);
					if (data.count * data.aliasCount > maxAliasCount) throw new ReferenceError("Excessive alias count indicates a resource exhaustion attack");
				}
			}
			return found;
		}
		toJSON(_arg, ctx) {
			if (!ctx) return { source: this.source };
			const source = this.resolve(ctx.doc, ctx);
			if (!source) {
				const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
				throw new ReferenceError(msg);
			}
			return ctx.anchors.get(source).res;
		}
		toString(ctx, _onComment, _onChompKeep) {
			const src = `*${this.source}`;
			if (ctx) {
				anchors.anchorIsValid(this.source);
				if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
					const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
					throw new Error(msg);
				}
				if (ctx.implicitKey) return `${src} `;
			}
			return src;
		}
	};
	function getAliasCount(doc, node, anchors) {
		if (identity.isAlias(node)) {
			const source = node.resolve(doc);
			const anchor = anchors && source && anchors.get(source);
			return anchor ? anchor.count * anchor.aliasCount : 0;
		} else if (identity.isCollection(node)) {
			let count = 0;
			for (const item of node.items) {
				const c = getAliasCount(doc, item, anchors);
				if (c > count) count = c;
			}
			return count;
		} else if (identity.isPair(node)) {
			const kc = getAliasCount(doc, node.key, anchors);
			const vc = getAliasCount(doc, node.value, anchors);
			return Math.max(kc, vc);
		}
		return 1;
	}
	exports.Alias = Alias;
}));

// node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Node = require_Node();
	var toJS = require_toJS();
	const isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
	var Scalar = class extends Node.NodeBase {
		constructor(value) {
			super(identity.SCALAR);
			this.value = value;
		}
		toJSON(arg, ctx) {
			return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
		}
		toString() {
			return String(this.value);
		}
	};
	Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
	Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
	Scalar.PLAIN = "PLAIN";
	Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
	Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
	exports.Scalar = Scalar;
	exports.isScalarValue = isScalarValue;
}));

// node_modules/yaml/dist/doc/createNode.js
var require_createNode = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Alias = require_Alias();
	var identity = require_identity();
	var Scalar = require_Scalar();
	const defaultTagPrefix = "tag:yaml.org,2002:";
	function findTagObject(value, tagName, tags) {
		if (tagName) {
			const match = tags.filter((t) => t.tag === tagName);
			const tagObj = match.find((t) => !t.format) ?? match[0];
			if (!tagObj) throw new Error(`Tag ${tagName} not found`);
			return tagObj;
		}
		return tags.find((t) => t.identify?.(value) && !t.format);
	}
	function createNode(value, tagName, ctx) {
		if (identity.isDocument(value)) value = value.contents;
		if (identity.isNode(value)) return value;
		if (identity.isPair(value)) {
			const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
			map.items.push(value);
			return map;
		}
		if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) value = value.valueOf();
		const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
		let ref = void 0;
		if (aliasDuplicateObjects && value && typeof value === "object") {
			ref = sourceObjects.get(value);
			if (ref) {
				ref.anchor ?? (ref.anchor = onAnchor(value));
				return new Alias.Alias(ref.anchor);
			} else {
				ref = {
					anchor: null,
					node: null
				};
				sourceObjects.set(value, ref);
			}
		}
		if (tagName?.startsWith("!!")) tagName = defaultTagPrefix + tagName.slice(2);
		let tagObj = findTagObject(value, tagName, schema.tags);
		if (!tagObj) {
			if (value && typeof value.toJSON === "function") value = value.toJSON();
			if (!value || typeof value !== "object") {
				const node = new Scalar.Scalar(value);
				if (ref) ref.node = node;
				return node;
			}
			tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
		}
		if (onTagObj) {
			onTagObj(tagObj);
			delete ctx.onTagObj;
		}
		const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
		if (tagName) node.tag = tagName;
		else if (!tagObj.default) node.tag = tagObj.tag;
		if (ref) ref.node = node;
		return node;
	}
	exports.createNode = createNode;
}));

// node_modules/yaml/dist/nodes/Collection.js
var require_Collection = /* @__PURE__ */ __commonJSMin(((exports) => {
	var createNode = require_createNode();
	var identity = require_identity();
	var Node = require_Node();
	function collectionFromPath(schema, path, value) {
		let v = value;
		for (let i = path.length - 1; i >= 0; --i) {
			const k = path[i];
			if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
				const a = [];
				a[k] = v;
				v = a;
			} else v = /* @__PURE__ */ new Map([[k, v]]);
		}
		return createNode.createNode(v, void 0, {
			aliasDuplicateObjects: false,
			keepUndefined: false,
			onAnchor: () => {
				throw new Error("This should not happen, please report a bug.");
			},
			schema,
			sourceObjects: /* @__PURE__ */ new Map()
		});
	}
	const isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
	var Collection = class extends Node.NodeBase {
		constructor(type, schema) {
			super(type);
			Object.defineProperty(this, "schema", {
				value: schema,
				configurable: true,
				enumerable: false,
				writable: true
			});
		}
		/**
		* Create a copy of this collection.
		*
		* @param schema - If defined, overwrites the original's schema
		*/
		clone(schema) {
			const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
			if (schema) copy.schema = schema;
			copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
			if (this.range) copy.range = this.range.slice();
			return copy;
		}
		/**
		* Adds a value to the collection. For `!!map` and `!!omap` the value must
		* be a Pair instance or a `{ key, value }` object, which may not have a key
		* that already exists in the map.
		*/
		addIn(path, value) {
			if (isEmptyPath(path)) this.add(value);
			else {
				const [key, ...rest] = path;
				const node = this.get(key, true);
				if (identity.isCollection(node)) node.addIn(rest, value);
				else if (node === void 0 && this.schema) this.set(key, collectionFromPath(this.schema, rest, value));
				else throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
			}
		}
		/**
		* Removes a value from the collection.
		* @returns `true` if the item was found and removed.
		*/
		deleteIn(path) {
			const [key, ...rest] = path;
			if (rest.length === 0) return this.delete(key);
			const node = this.get(key, true);
			if (identity.isCollection(node)) return node.deleteIn(rest);
			else throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
		}
		/**
		* Returns item at `key`, or `undefined` if not found. By default unwraps
		* scalar values from their surrounding node; to disable set `keepScalar` to
		* `true` (collections are always returned intact).
		*/
		getIn(path, keepScalar) {
			const [key, ...rest] = path;
			const node = this.get(key, true);
			if (rest.length === 0) return !keepScalar && identity.isScalar(node) ? node.value : node;
			else return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
		}
		hasAllNullValues(allowScalar) {
			return this.items.every((node) => {
				if (!identity.isPair(node)) return false;
				const n = node.value;
				return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
			});
		}
		/**
		* Checks if the collection includes a value with the key `key`.
		*/
		hasIn(path) {
			const [key, ...rest] = path;
			if (rest.length === 0) return this.has(key);
			const node = this.get(key, true);
			return identity.isCollection(node) ? node.hasIn(rest) : false;
		}
		/**
		* Sets a value in this collection. For `!!set`, `value` needs to be a
		* boolean to add/remove the item from the set.
		*/
		setIn(path, value) {
			const [key, ...rest] = path;
			if (rest.length === 0) this.set(key, value);
			else {
				const node = this.get(key, true);
				if (identity.isCollection(node)) node.setIn(rest, value);
				else if (node === void 0 && this.schema) this.set(key, collectionFromPath(this.schema, rest, value));
				else throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
			}
		}
	};
	exports.Collection = Collection;
	exports.collectionFromPath = collectionFromPath;
	exports.isEmptyPath = isEmptyPath;
}));

// node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Stringifies a comment.
	*
	* Empty comment lines are left empty,
	* lines consisting of a single space are replaced by `#`,
	* and all other lines are prefixed with a `#`.
	*/
	const stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
	function indentComment(comment, indent) {
		if (/^\n+$/.test(comment)) return comment.substring(1);
		return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
	}
	const lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
	exports.indentComment = indentComment;
	exports.lineComment = lineComment;
	exports.stringifyComment = stringifyComment;
}));

// node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = /* @__PURE__ */ __commonJSMin(((exports) => {
	const FOLD_FLOW = "flow";
	const FOLD_BLOCK = "block";
	const FOLD_QUOTED = "quoted";
	/**
	* Tries to keep input at up to `lineWidth` characters, splitting only on spaces
	* not followed by newlines or spaces unless `mode` is `'quoted'`. Lines are
	* terminated with `\n` and started with `indent`.
	*/
	function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
		if (!lineWidth || lineWidth < 0) return text;
		if (lineWidth < minContentWidth) minContentWidth = 0;
		const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
		if (text.length <= endStep) return text;
		const folds = [];
		const escapedFolds = {};
		let end = lineWidth - indent.length;
		if (typeof indentAtStart === "number") {
			if (indentAtStart > lineWidth - Math.max(2, minContentWidth)) folds.push(0);
			else end = lineWidth - indentAtStart;
		}
		let split = void 0;
		let prev = void 0;
		let overflow = false;
		let i = -1;
		let escStart = -1;
		let escEnd = -1;
		if (mode === FOLD_BLOCK) {
			i = consumeMoreIndentedLines(text, i, indent.length);
			if (i !== -1) end = i + endStep;
		}
		for (let ch; ch = text[i += 1];) {
			if (mode === FOLD_QUOTED && ch === "\\") {
				escStart = i;
				switch (text[i + 1]) {
					case "x":
						i += 3;
						break;
					case "u":
						i += 5;
						break;
					case "U":
						i += 9;
						break;
					default: i += 1;
				}
				escEnd = i;
			}
			if (ch === "\n") {
				if (mode === FOLD_BLOCK) i = consumeMoreIndentedLines(text, i, indent.length);
				end = i + indent.length + endStep;
				split = void 0;
			} else {
				if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
					const next = text[i + 1];
					if (next && next !== " " && next !== "\n" && next !== "	") split = i;
				}
				if (i >= end) {
					if (split) {
						folds.push(split);
						end = split + endStep;
						split = void 0;
					} else if (mode === FOLD_QUOTED) {
						while (prev === " " || prev === "	") {
							prev = ch;
							ch = text[i += 1];
							overflow = true;
						}
						const j = i > escEnd + 1 ? i - 2 : escStart - 1;
						if (escapedFolds[j]) return text;
						folds.push(j);
						escapedFolds[j] = true;
						end = j + endStep;
						split = void 0;
					} else overflow = true;
				}
			}
			prev = ch;
		}
		if (overflow && onOverflow) onOverflow();
		if (folds.length === 0) return text;
		if (onFold) onFold();
		let res = text.slice(0, folds[0]);
		for (let i = 0; i < folds.length; ++i) {
			const fold = folds[i];
			const end = folds[i + 1] || text.length;
			if (fold === 0) res = `\n${indent}${text.slice(0, end)}`;
			else {
				if (mode === FOLD_QUOTED && escapedFolds[fold]) res += `${text[fold]}\\`;
				res += `\n${indent}${text.slice(fold + 1, end)}`;
			}
		}
		return res;
	}
	/**
	* Presumes `i + 1` is at the start of a line
	* @returns index of last newline in more-indented block
	*/
	function consumeMoreIndentedLines(text, i, indent) {
		let end = i;
		let start = i + 1;
		let ch = text[start];
		while (ch === " " || ch === "	") if (i < start + indent) ch = text[++i];
		else {
			do
				ch = text[++i];
			while (ch && ch !== "\n");
			end = i;
			start = i + 1;
			ch = text[start];
		}
		return end;
	}
	exports.FOLD_BLOCK = FOLD_BLOCK;
	exports.FOLD_FLOW = FOLD_FLOW;
	exports.FOLD_QUOTED = FOLD_QUOTED;
	exports.foldFlowLines = foldFlowLines;
}));

// node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	var foldFlowLines = require_foldFlowLines();
	const getFoldOptions = (ctx, isBlock) => ({
		indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
		lineWidth: ctx.options.lineWidth,
		minContentWidth: ctx.options.minContentWidth
	});
	const containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
	function lineLengthOverLimit(str, lineWidth, indentLength) {
		if (!lineWidth || lineWidth < 0) return false;
		const limit = lineWidth - indentLength;
		const strLen = str.length;
		if (strLen <= limit) return false;
		for (let i = 0, start = 0; i < strLen; ++i) if (str[i] === "\n") {
			if (i - start > limit) return true;
			start = i + 1;
			if (strLen - start <= limit) return false;
		}
		return true;
	}
	function doubleQuotedString(value, ctx) {
		const json = JSON.stringify(value);
		if (ctx.options.doubleQuotedAsJSON) return json;
		const { implicitKey } = ctx;
		const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
		const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
		let str = "";
		let start = 0;
		for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
			if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
				str += json.slice(start, i) + "\\ ";
				i += 1;
				start = i;
				ch = "\\";
			}
			if (ch === "\\") switch (json[i + 1]) {
				case "u":
					{
						str += json.slice(start, i);
						const code = json.substr(i + 2, 4);
						switch (code) {
							case "0000":
								str += "\\0";
								break;
							case "0007":
								str += "\\a";
								break;
							case "000b":
								str += "\\v";
								break;
							case "001b":
								str += "\\e";
								break;
							case "0085":
								str += "\\N";
								break;
							case "00a0":
								str += "\\_";
								break;
							case "2028":
								str += "\\L";
								break;
							case "2029":
								str += "\\P";
								break;
							default: if (code.substr(0, 2) === "00") str += "\\x" + code.substr(2);
							else str += json.substr(i, 6);
						}
						i += 5;
						start = i + 1;
					}
					break;
				case "n":
					if (implicitKey || json[i + 2] === "\"" || json.length < minMultiLineLength) i += 1;
					else {
						str += json.slice(start, i) + "\n\n";
						while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== "\"") {
							str += "\n";
							i += 2;
						}
						str += indent;
						if (json[i + 2] === " ") str += "\\";
						i += 1;
						start = i + 1;
					}
					break;
				default: i += 1;
			}
		}
		str = start ? str + json.slice(start) : json;
		return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
	}
	function singleQuotedString(value, ctx) {
		if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value)) return doubleQuotedString(value, ctx);
		const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
		const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&\n${indent}`) + "'";
		return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
	}
	function quotedString(value, ctx) {
		const { singleQuote } = ctx.options;
		let qs;
		if (singleQuote === false) qs = doubleQuotedString;
		else {
			const hasDouble = value.includes("\"");
			const hasSingle = value.includes("'");
			if (hasDouble && !hasSingle) qs = singleQuotedString;
			else if (hasSingle && !hasDouble) qs = doubleQuotedString;
			else qs = singleQuote ? singleQuotedString : doubleQuotedString;
		}
		return qs(value, ctx);
	}
	let blockEndNewlines;
	try {
		blockEndNewlines = /* @__PURE__ */ new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
	} catch {
		blockEndNewlines = /\n+(?!\n|$)/g;
	}
	function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
		const { blockQuote, commentString, lineWidth } = ctx.options;
		if (!blockQuote || /\n[\t ]+$/.test(value)) return quotedString(value, ctx);
		const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
		const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
		if (!value) return literal ? "|\n" : ">\n";
		let chomp;
		let endStart;
		for (endStart = value.length; endStart > 0; --endStart) {
			const ch = value[endStart - 1];
			if (ch !== "\n" && ch !== "	" && ch !== " ") break;
		}
		let end = value.substring(endStart);
		const endNlPos = end.indexOf("\n");
		if (endNlPos === -1) chomp = "-";
		else if (value === end || endNlPos !== end.length - 1) {
			chomp = "+";
			if (onChompKeep) onChompKeep();
		} else chomp = "";
		if (end) {
			value = value.slice(0, -end.length);
			if (end[end.length - 1] === "\n") end = end.slice(0, -1);
			end = end.replace(blockEndNewlines, `$&${indent}`);
		}
		let startWithSpace = false;
		let startEnd;
		let startNlPos = -1;
		for (startEnd = 0; startEnd < value.length; ++startEnd) {
			const ch = value[startEnd];
			if (ch === " ") startWithSpace = true;
			else if (ch === "\n") startNlPos = startEnd;
			else break;
		}
		let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
		if (start) {
			value = value.substring(start.length);
			start = start.replace(/\n+/g, `$&${indent}`);
		}
		let header = (startWithSpace ? indent ? "2" : "1" : "") + chomp;
		if (comment) {
			header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
			if (onComment) onComment();
		}
		if (!literal) {
			const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
			let literalFallback = false;
			const foldOptions = getFoldOptions(ctx, true);
			if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) foldOptions.onOverflow = () => {
				literalFallback = true;
			};
			const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
			if (!literalFallback) return `>${header}\n${indent}${body}`;
		}
		value = value.replace(/\n+/g, `$&${indent}`);
		return `|${header}\n${indent}${start}${value}${end}`;
	}
	function plainString(item, ctx, onComment, onChompKeep) {
		const { type, value } = item;
		const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
		if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) return quotedString(value, ctx);
		if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
		if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes("\n")) return blockString(item, ctx, onComment, onChompKeep);
		if (containsDocumentMarker(value)) {
			if (indent === "") {
				ctx.forceBlockIndent = true;
				return blockString(item, ctx, onComment, onChompKeep);
			} else if (implicitKey && indent === indentStep) return quotedString(value, ctx);
		}
		const str = value.replace(/\n+/g, `$&\n${indent}`);
		if (actualString) {
			const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
			const { compat, tags } = ctx.doc.schema;
			if (tags.some(test) || compat?.some(test)) return quotedString(value, ctx);
		}
		return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
	}
	function stringifyString(item, ctx, onComment, onChompKeep) {
		const { implicitKey, inFlow } = ctx;
		const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
		let { type } = item;
		if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
			if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value)) type = Scalar.Scalar.QUOTE_DOUBLE;
		}
		const _stringify = (_type) => {
			switch (_type) {
				case Scalar.Scalar.BLOCK_FOLDED:
				case Scalar.Scalar.BLOCK_LITERAL: return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
				case Scalar.Scalar.QUOTE_DOUBLE: return doubleQuotedString(ss.value, ctx);
				case Scalar.Scalar.QUOTE_SINGLE: return singleQuotedString(ss.value, ctx);
				case Scalar.Scalar.PLAIN: return plainString(ss, ctx, onComment, onChompKeep);
				default: return null;
			}
		};
		let res = _stringify(type);
		if (res === null) {
			const { defaultKeyType, defaultStringType } = ctx.options;
			const t = implicitKey && defaultKeyType || defaultStringType;
			res = _stringify(t);
			if (res === null) throw new Error(`Unsupported default string type ${t}`);
		}
		return res;
	}
	exports.stringifyString = stringifyString;
}));

// node_modules/yaml/dist/stringify/stringify.js
var require_stringify = /* @__PURE__ */ __commonJSMin(((exports) => {
	var anchors = require_anchors();
	var identity = require_identity();
	var stringifyComment = require_stringifyComment();
	var stringifyString = require_stringifyString();
	function createStringifyContext(doc, options) {
		const opt = Object.assign({
			blockQuote: true,
			commentString: stringifyComment.stringifyComment,
			defaultKeyType: null,
			defaultStringType: "PLAIN",
			directives: null,
			doubleQuotedAsJSON: false,
			doubleQuotedMinMultiLineLength: 40,
			falseStr: "false",
			flowCollectionPadding: true,
			indentSeq: true,
			lineWidth: 80,
			minContentWidth: 20,
			nullStr: "null",
			simpleKeys: false,
			singleQuote: null,
			trailingComma: false,
			trueStr: "true",
			verifyAliasOrder: true
		}, doc.schema.toStringOptions, options);
		let inFlow;
		switch (opt.collectionStyle) {
			case "block":
				inFlow = false;
				break;
			case "flow":
				inFlow = true;
				break;
			default: inFlow = null;
		}
		return {
			anchors: /* @__PURE__ */ new Set(),
			doc,
			flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
			indent: "",
			indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
			inFlow,
			options: opt
		};
	}
	function getTagObject(tags, item) {
		if (item.tag) {
			const match = tags.filter((t) => t.tag === item.tag);
			if (match.length > 0) return match.find((t) => t.format === item.format) ?? match[0];
		}
		let tagObj = void 0;
		let obj;
		if (identity.isScalar(item)) {
			obj = item.value;
			let match = tags.filter((t) => t.identify?.(obj));
			if (match.length > 1) {
				const testMatch = match.filter((t) => t.test);
				if (testMatch.length > 0) match = testMatch;
			}
			tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
		} else {
			obj = item;
			tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
		}
		if (!tagObj) {
			const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
			throw new Error(`Tag not resolved for ${name} value`);
		}
		return tagObj;
	}
	function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
		if (!doc.directives) return "";
		const props = [];
		const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
		if (anchor && anchors.anchorIsValid(anchor)) {
			anchors$1.add(anchor);
			props.push(`&${anchor}`);
		}
		const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
		if (tag) props.push(doc.directives.tagString(tag));
		return props.join(" ");
	}
	function stringify(item, ctx, onComment, onChompKeep) {
		if (identity.isPair(item)) return item.toString(ctx, onComment, onChompKeep);
		if (identity.isAlias(item)) {
			if (ctx.doc.directives) return item.toString(ctx);
			if (ctx.resolvedAliases?.has(item)) throw new TypeError(`Cannot stringify circular structure without alias nodes`);
			else {
				if (ctx.resolvedAliases) ctx.resolvedAliases.add(item);
				else ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
				item = item.resolve(ctx.doc);
			}
		}
		let tagObj = void 0;
		const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
		tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
		const props = stringifyProps(node, tagObj, ctx);
		if (props.length > 0) ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
		const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
		if (!props) return str;
		return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}\n${ctx.indent}${str}`;
	}
	exports.createStringifyContext = createStringifyContext;
	exports.stringify = stringify;
}));

// node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Scalar = require_Scalar();
	var stringify = require_stringify();
	var stringifyComment = require_stringifyComment();
	function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
		const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
		let keyComment = identity.isNode(key) && key.comment || null;
		if (simpleKeys) {
			if (keyComment) throw new Error("With simple keys, key nodes cannot have comments");
			if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") throw new Error("With simple keys, collection cannot be used as a key value");
		}
		let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
		ctx = Object.assign({}, ctx, {
			allNullValues: false,
			implicitKey: !explicitKey && (simpleKeys || !allNullValues),
			indent: indent + indentStep
		});
		let keyCommentDone = false;
		let chompKeep = false;
		let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
		if (!explicitKey && !ctx.inFlow && str.length > 1024) {
			if (simpleKeys) throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
			explicitKey = true;
		}
		if (ctx.inFlow) {
			if (allNullValues || value == null) {
				if (keyCommentDone && onComment) onComment();
				return str === "" ? "?" : explicitKey ? `? ${str}` : str;
			}
		} else if (allNullValues && !simpleKeys || value == null && explicitKey) {
			str = `? ${str}`;
			if (keyComment && !keyCommentDone) str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
			else if (chompKeep && onChompKeep) onChompKeep();
			return str;
		}
		if (keyCommentDone) keyComment = null;
		if (explicitKey) {
			if (keyComment) str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
			str = `? ${str}\n${indent}:`;
		} else {
			str = `${str}:`;
			if (keyComment) str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
		}
		let vsb, vcb, valueComment;
		if (identity.isNode(value)) {
			vsb = !!value.spaceBefore;
			vcb = value.commentBefore;
			valueComment = value.comment;
		} else {
			vsb = false;
			vcb = null;
			valueComment = null;
			if (value && typeof value === "object") value = doc.createNode(value);
		}
		ctx.implicitKey = false;
		if (!explicitKey && !keyComment && identity.isScalar(value)) ctx.indentAtStart = str.length + 1;
		chompKeep = false;
		if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) ctx.indent = ctx.indent.substring(2);
		let valueCommentDone = false;
		const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
		let ws = " ";
		if (keyComment || vsb || vcb) {
			ws = vsb ? "\n" : "";
			if (vcb) {
				const cs = commentString(vcb);
				ws += `\n${stringifyComment.indentComment(cs, ctx.indent)}`;
			}
			if (valueStr === "" && !ctx.inFlow) {
				if (ws === "\n" && valueComment) ws = "\n\n";
			} else ws += `\n${ctx.indent}`;
		} else if (!explicitKey && identity.isCollection(value)) {
			const vs0 = valueStr[0];
			const nl0 = valueStr.indexOf("\n");
			const hasNewline = nl0 !== -1;
			const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
			if (hasNewline || !flow) {
				let hasPropsLine = false;
				if (hasNewline && (vs0 === "&" || vs0 === "!")) {
					let sp0 = valueStr.indexOf(" ");
					if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") sp0 = valueStr.indexOf(" ", sp0 + 1);
					if (sp0 === -1 || nl0 < sp0) hasPropsLine = true;
				}
				if (!hasPropsLine) ws = `\n${ctx.indent}`;
			}
		} else if (valueStr === "" || valueStr[0] === "\n") ws = "";
		str += ws + valueStr;
		if (ctx.inFlow) {
			if (valueCommentDone && onComment) onComment();
		} else if (valueComment && !valueCommentDone) str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
		else if (chompKeep && onChompKeep) onChompKeep();
		return str;
	}
	exports.stringifyPair = stringifyPair;
}));

// node_modules/yaml/dist/log.js
var require_log = /* @__PURE__ */ __commonJSMin(((exports) => {
	var node_process = __require("process");
	function debug(logLevel, ...messages) {
		if (logLevel === "debug") console.log(...messages);
	}
	function warn(logLevel, warning) {
		if (logLevel === "debug" || logLevel === "warn") {
			if (typeof node_process.emitWarning === "function") node_process.emitWarning(warning);
			else console.warn(warning);
		}
	}
	exports.debug = debug;
	exports.warn = warn;
}));

// node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Scalar = require_Scalar();
	const MERGE_KEY = "<<";
	const merge = {
		identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
		default: "key",
		tag: "tag:yaml.org,2002:merge",
		test: /^<<$/,
		resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), { addToJSMap: addMergeToJSMap }),
		stringify: () => MERGE_KEY
	};
	const isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
	function addMergeToJSMap(ctx, map, value) {
		const source = resolveAliasValue(ctx, value);
		if (identity.isSeq(source)) for (const it of source.items) mergeValue(ctx, map, it);
		else if (Array.isArray(source)) for (const it of source) mergeValue(ctx, map, it);
		else mergeValue(ctx, map, source);
	}
	function mergeValue(ctx, map, value) {
		const source = resolveAliasValue(ctx, value);
		if (!identity.isMap(source)) throw new Error("Merge sources must be maps or map aliases");
		const srcMap = source.toJSON(null, ctx, Map);
		for (const [key, value] of srcMap) if (map instanceof Map) {
			if (!map.has(key)) map.set(key, value);
		} else if (map instanceof Set) map.add(key);
		else if (!Object.prototype.hasOwnProperty.call(map, key)) Object.defineProperty(map, key, {
			value,
			writable: true,
			enumerable: true,
			configurable: true
		});
		return map;
	}
	function resolveAliasValue(ctx, value) {
		return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
	}
	exports.addMergeToJSMap = addMergeToJSMap;
	exports.isMergeKey = isMergeKey;
	exports.merge = merge;
}));

// node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = /* @__PURE__ */ __commonJSMin(((exports) => {
	var log = require_log();
	var merge = require_merge();
	var stringify = require_stringify();
	var identity = require_identity();
	var toJS = require_toJS();
	function addPairToJSMap(ctx, map, { key, value }) {
		if (identity.isNode(key) && key.addToJSMap) key.addToJSMap(ctx, map, value);
		else if (merge.isMergeKey(ctx, key)) merge.addMergeToJSMap(ctx, map, value);
		else {
			const jsKey = toJS.toJS(key, "", ctx);
			if (map instanceof Map) map.set(jsKey, toJS.toJS(value, jsKey, ctx));
			else if (map instanceof Set) map.add(jsKey);
			else {
				const stringKey = stringifyKey(key, jsKey, ctx);
				const jsValue = toJS.toJS(value, stringKey, ctx);
				if (stringKey in map) Object.defineProperty(map, stringKey, {
					value: jsValue,
					writable: true,
					enumerable: true,
					configurable: true
				});
				else map[stringKey] = jsValue;
			}
		}
		return map;
	}
	function stringifyKey(key, jsKey, ctx) {
		if (jsKey === null) return "";
		if (typeof jsKey !== "object") return String(jsKey);
		if (identity.isNode(key) && ctx?.doc) {
			const strCtx = stringify.createStringifyContext(ctx.doc, {});
			strCtx.anchors = /* @__PURE__ */ new Set();
			for (const node of ctx.anchors.keys()) strCtx.anchors.add(node.anchor);
			strCtx.inFlow = true;
			strCtx.inStringifyKey = true;
			const strKey = key.toString(strCtx);
			if (!ctx.mapKeyWarned) {
				let jsonStr = JSON.stringify(strKey);
				if (jsonStr.length > 40) jsonStr = jsonStr.substring(0, 36) + "...\"";
				log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
				ctx.mapKeyWarned = true;
			}
			return strKey;
		}
		return JSON.stringify(jsKey);
	}
	exports.addPairToJSMap = addPairToJSMap;
}));

// node_modules/yaml/dist/nodes/Pair.js
var require_Pair = /* @__PURE__ */ __commonJSMin(((exports) => {
	var createNode = require_createNode();
	var stringifyPair = require_stringifyPair();
	var addPairToJSMap = require_addPairToJSMap();
	var identity = require_identity();
	function createPair(key, value, ctx) {
		const k = createNode.createNode(key, void 0, ctx);
		const v = createNode.createNode(value, void 0, ctx);
		return new Pair(k, v);
	}
	var Pair = class Pair {
		constructor(key, value = null) {
			Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
			this.key = key;
			this.value = value;
		}
		clone(schema) {
			let { key, value } = this;
			if (identity.isNode(key)) key = key.clone(schema);
			if (identity.isNode(value)) value = value.clone(schema);
			return new Pair(key, value);
		}
		toJSON(_, ctx) {
			const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
			return addPairToJSMap.addPairToJSMap(ctx, pair, this);
		}
		toString(ctx, onComment, onChompKeep) {
			return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
		}
	};
	exports.Pair = Pair;
	exports.createPair = createPair;
}));

// node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var stringify = require_stringify();
	var stringifyComment = require_stringifyComment();
	function stringifyCollection(collection, ctx, options) {
		return (ctx.inFlow ?? collection.flow ? stringifyFlowCollection : stringifyBlockCollection)(collection, ctx, options);
	}
	function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
		const { indent, options: { commentString } } = ctx;
		const itemCtx = Object.assign({}, ctx, {
			indent: itemIndent,
			type: null
		});
		let chompKeep = false;
		const lines = [];
		for (let i = 0; i < items.length; ++i) {
			const item = items[i];
			let comment = null;
			if (identity.isNode(item)) {
				if (!chompKeep && item.spaceBefore) lines.push("");
				addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
				if (item.comment) comment = item.comment;
			} else if (identity.isPair(item)) {
				const ik = identity.isNode(item.key) ? item.key : null;
				if (ik) {
					if (!chompKeep && ik.spaceBefore) lines.push("");
					addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
				}
			}
			chompKeep = false;
			let str = stringify.stringify(item, itemCtx, () => comment = null, () => chompKeep = true);
			if (comment) str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
			if (chompKeep && comment) chompKeep = false;
			lines.push(blockItemPrefix + str);
		}
		let str;
		if (lines.length === 0) str = flowChars.start + flowChars.end;
		else {
			str = lines[0];
			for (let i = 1; i < lines.length; ++i) {
				const line = lines[i];
				str += line ? `\n${indent}${line}` : "\n";
			}
		}
		if (comment) {
			str += "\n" + stringifyComment.indentComment(commentString(comment), indent);
			if (onComment) onComment();
		} else if (chompKeep && onChompKeep) onChompKeep();
		return str;
	}
	function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
		const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
		itemIndent += indentStep;
		const itemCtx = Object.assign({}, ctx, {
			indent: itemIndent,
			inFlow: true,
			type: null
		});
		let reqNewline = false;
		let linesAtValue = 0;
		const lines = [];
		for (let i = 0; i < items.length; ++i) {
			const item = items[i];
			let comment = null;
			if (identity.isNode(item)) {
				if (item.spaceBefore) lines.push("");
				addCommentBefore(ctx, lines, item.commentBefore, false);
				if (item.comment) comment = item.comment;
			} else if (identity.isPair(item)) {
				const ik = identity.isNode(item.key) ? item.key : null;
				if (ik) {
					if (ik.spaceBefore) lines.push("");
					addCommentBefore(ctx, lines, ik.commentBefore, false);
					if (ik.comment) reqNewline = true;
				}
				const iv = identity.isNode(item.value) ? item.value : null;
				if (iv) {
					if (iv.comment) comment = iv.comment;
					if (iv.commentBefore) reqNewline = true;
				} else if (item.value == null && ik?.comment) comment = ik.comment;
			}
			if (comment) reqNewline = true;
			let str = stringify.stringify(item, itemCtx, () => comment = null);
			reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
			if (i < items.length - 1) str += ",";
			else if (ctx.options.trailingComma) {
				if (ctx.options.lineWidth > 0) reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
				if (reqNewline) str += ",";
			}
			if (comment) str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
			lines.push(str);
			linesAtValue = lines.length;
		}
		const { start, end } = flowChars;
		if (lines.length === 0) return start + end;
		else {
			if (!reqNewline) {
				const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
				reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
			}
			if (reqNewline) {
				let str = start;
				for (const line of lines) str += line ? `\n${indentStep}${indent}${line}` : "\n";
				return `${str}\n${indent}${end}`;
			} else return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
		}
	}
	function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
		if (comment && chompKeep) comment = comment.replace(/^\n+/, "");
		if (comment) {
			const ic = stringifyComment.indentComment(commentString(comment), indent);
			lines.push(ic.trimStart());
		}
	}
	exports.stringifyCollection = stringifyCollection;
}));

// node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = /* @__PURE__ */ __commonJSMin(((exports) => {
	var stringifyCollection = require_stringifyCollection();
	var addPairToJSMap = require_addPairToJSMap();
	var Collection = require_Collection();
	var identity = require_identity();
	var Pair = require_Pair();
	var Scalar = require_Scalar();
	function findPair(items, key) {
		const k = identity.isScalar(key) ? key.value : key;
		for (const it of items) if (identity.isPair(it)) {
			if (it.key === key || it.key === k) return it;
			if (identity.isScalar(it.key) && it.key.value === k) return it;
		}
	}
	var YAMLMap = class extends Collection.Collection {
		static get tagName() {
			return "tag:yaml.org,2002:map";
		}
		constructor(schema) {
			super(identity.MAP, schema);
			this.items = [];
		}
		/**
		* A generic collection parsing method that can be extended
		* to other node classes that inherit from YAMLMap
		*/
		static from(schema, obj, ctx) {
			const { keepUndefined, replacer } = ctx;
			const map = new this(schema);
			const add = (key, value) => {
				if (typeof replacer === "function") value = replacer.call(obj, key, value);
				else if (Array.isArray(replacer) && !replacer.includes(key)) return;
				if (value !== void 0 || keepUndefined) map.items.push(Pair.createPair(key, value, ctx));
			};
			if (obj instanceof Map) for (const [key, value] of obj) add(key, value);
			else if (obj && typeof obj === "object") for (const key of Object.keys(obj)) add(key, obj[key]);
			if (typeof schema.sortMapEntries === "function") map.items.sort(schema.sortMapEntries);
			return map;
		}
		/**
		* Adds a value to the collection.
		*
		* @param overwrite - If not set `true`, using a key that is already in the
		*   collection will throw. Otherwise, overwrites the previous value.
		*/
		add(pair, overwrite) {
			let _pair;
			if (identity.isPair(pair)) _pair = pair;
			else if (!pair || typeof pair !== "object" || !("key" in pair)) _pair = new Pair.Pair(pair, pair?.value);
			else _pair = new Pair.Pair(pair.key, pair.value);
			const prev = findPair(this.items, _pair.key);
			const sortEntries = this.schema?.sortMapEntries;
			if (prev) {
				if (!overwrite) throw new Error(`Key ${_pair.key} already set`);
				if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value)) prev.value.value = _pair.value;
				else prev.value = _pair.value;
			} else if (sortEntries) {
				const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
				if (i === -1) this.items.push(_pair);
				else this.items.splice(i, 0, _pair);
			} else this.items.push(_pair);
		}
		delete(key) {
			const it = findPair(this.items, key);
			if (!it) return false;
			return this.items.splice(this.items.indexOf(it), 1).length > 0;
		}
		get(key, keepScalar) {
			const node = findPair(this.items, key)?.value;
			return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
		}
		has(key) {
			return !!findPair(this.items, key);
		}
		set(key, value) {
			this.add(new Pair.Pair(key, value), true);
		}
		/**
		* @param ctx - Conversion context, originally set in Document#toJS()
		* @param {Class} Type - If set, forces the returned collection type
		* @returns Instance of Type, Map, or Object
		*/
		toJSON(_, ctx, Type) {
			const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
			if (ctx?.onCreate) ctx.onCreate(map);
			for (const item of this.items) addPairToJSMap.addPairToJSMap(ctx, map, item);
			return map;
		}
		toString(ctx, onComment, onChompKeep) {
			if (!ctx) return JSON.stringify(this);
			for (const item of this.items) if (!identity.isPair(item)) throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
			if (!ctx.allNullValues && this.hasAllNullValues(false)) ctx = Object.assign({}, ctx, { allNullValues: true });
			return stringifyCollection.stringifyCollection(this, ctx, {
				blockItemPrefix: "",
				flowChars: {
					start: "{",
					end: "}"
				},
				itemIndent: ctx.indent || "",
				onChompKeep,
				onComment
			});
		}
	};
	exports.YAMLMap = YAMLMap;
	exports.findPair = findPair;
}));

// node_modules/yaml/dist/schema/common/map.js
var require_map = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var YAMLMap = require_YAMLMap();
	const map = {
		collection: "map",
		default: true,
		nodeClass: YAMLMap.YAMLMap,
		tag: "tag:yaml.org,2002:map",
		resolve(map, onError) {
			if (!identity.isMap(map)) onError("Expected a mapping for this tag");
			return map;
		},
		createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
	};
	exports.map = map;
}));

// node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = /* @__PURE__ */ __commonJSMin(((exports) => {
	var createNode = require_createNode();
	var stringifyCollection = require_stringifyCollection();
	var Collection = require_Collection();
	var identity = require_identity();
	var Scalar = require_Scalar();
	var toJS = require_toJS();
	var YAMLSeq = class extends Collection.Collection {
		static get tagName() {
			return "tag:yaml.org,2002:seq";
		}
		constructor(schema) {
			super(identity.SEQ, schema);
			this.items = [];
		}
		add(value) {
			this.items.push(value);
		}
		/**
		* Removes a value from the collection.
		*
		* `key` must contain a representation of an integer for this to succeed.
		* It may be wrapped in a `Scalar`.
		*
		* @returns `true` if the item was found and removed.
		*/
		delete(key) {
			const idx = asItemIndex(key);
			if (typeof idx !== "number") return false;
			return this.items.splice(idx, 1).length > 0;
		}
		get(key, keepScalar) {
			const idx = asItemIndex(key);
			if (typeof idx !== "number") return void 0;
			const it = this.items[idx];
			return !keepScalar && identity.isScalar(it) ? it.value : it;
		}
		/**
		* Checks if the collection includes a value with the key `key`.
		*
		* `key` must contain a representation of an integer for this to succeed.
		* It may be wrapped in a `Scalar`.
		*/
		has(key) {
			const idx = asItemIndex(key);
			return typeof idx === "number" && idx < this.items.length;
		}
		/**
		* Sets a value in this collection. For `!!set`, `value` needs to be a
		* boolean to add/remove the item from the set.
		*
		* If `key` does not contain a representation of an integer, this will throw.
		* It may be wrapped in a `Scalar`.
		*/
		set(key, value) {
			const idx = asItemIndex(key);
			if (typeof idx !== "number") throw new Error(`Expected a valid index, not ${key}.`);
			const prev = this.items[idx];
			if (identity.isScalar(prev) && Scalar.isScalarValue(value)) prev.value = value;
			else this.items[idx] = value;
		}
		toJSON(_, ctx) {
			const seq = [];
			if (ctx?.onCreate) ctx.onCreate(seq);
			let i = 0;
			for (const item of this.items) seq.push(toJS.toJS(item, String(i++), ctx));
			return seq;
		}
		toString(ctx, onComment, onChompKeep) {
			if (!ctx) return JSON.stringify(this);
			return stringifyCollection.stringifyCollection(this, ctx, {
				blockItemPrefix: "- ",
				flowChars: {
					start: "[",
					end: "]"
				},
				itemIndent: (ctx.indent || "") + "  ",
				onChompKeep,
				onComment
			});
		}
		static from(schema, obj, ctx) {
			const { replacer } = ctx;
			const seq = new this(schema);
			if (obj && Symbol.iterator in Object(obj)) {
				let i = 0;
				for (let it of obj) {
					if (typeof replacer === "function") {
						const key = obj instanceof Set ? it : String(i++);
						it = replacer.call(obj, key, it);
					}
					seq.items.push(createNode.createNode(it, void 0, ctx));
				}
			}
			return seq;
		}
	};
	function asItemIndex(key) {
		let idx = identity.isScalar(key) ? key.value : key;
		if (idx && typeof idx === "string") idx = Number(idx);
		return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
	}
	exports.YAMLSeq = YAMLSeq;
}));

// node_modules/yaml/dist/schema/common/seq.js
var require_seq = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var YAMLSeq = require_YAMLSeq();
	const seq = {
		collection: "seq",
		default: true,
		nodeClass: YAMLSeq.YAMLSeq,
		tag: "tag:yaml.org,2002:seq",
		resolve(seq, onError) {
			if (!identity.isSeq(seq)) onError("Expected a sequence for this tag");
			return seq;
		},
		createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
	};
	exports.seq = seq;
}));

// node_modules/yaml/dist/schema/common/string.js
var require_string = /* @__PURE__ */ __commonJSMin(((exports) => {
	var stringifyString = require_stringifyString();
	const string = {
		identify: (value) => typeof value === "string",
		default: true,
		tag: "tag:yaml.org,2002:str",
		resolve: (str) => str,
		stringify(item, ctx, onComment, onChompKeep) {
			ctx = Object.assign({ actualString: true }, ctx);
			return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
		}
	};
	exports.string = string;
}));

// node_modules/yaml/dist/schema/common/null.js
var require_null = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	const nullTag = {
		identify: (value) => value == null,
		createNode: () => new Scalar.Scalar(null),
		default: true,
		tag: "tag:yaml.org,2002:null",
		test: /^(?:~|[Nn]ull|NULL)?$/,
		resolve: () => new Scalar.Scalar(null),
		stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
	};
	exports.nullTag = nullTag;
}));

// node_modules/yaml/dist/schema/core/bool.js
var require_bool$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	const boolTag = {
		identify: (value) => typeof value === "boolean",
		default: true,
		tag: "tag:yaml.org,2002:bool",
		test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
		resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
		stringify({ source, value }, ctx) {
			if (source && boolTag.test.test(source)) {
				if (value === (source[0] === "t" || source[0] === "T")) return source;
			}
			return value ? ctx.options.trueStr : ctx.options.falseStr;
		}
	};
	exports.boolTag = boolTag;
}));

// node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = /* @__PURE__ */ __commonJSMin(((exports) => {
	function stringifyNumber({ format, minFractionDigits, tag, value }) {
		if (typeof value === "bigint") return String(value);
		const num = typeof value === "number" ? value : Number(value);
		if (!isFinite(num)) return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
		let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
		if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
			let i = n.indexOf(".");
			if (i < 0) {
				i = n.length;
				n += ".";
			}
			let d = minFractionDigits - (n.length - i - 1);
			while (d-- > 0) n += "0";
		}
		return n;
	}
	exports.stringifyNumber = stringifyNumber;
}));

// node_modules/yaml/dist/schema/core/float.js
var require_float$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	var stringifyNumber = require_stringifyNumber();
	const floatNaN = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
		resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
		stringify: stringifyNumber.stringifyNumber
	};
	const floatExp = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		format: "EXP",
		test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
		resolve: (str) => parseFloat(str),
		stringify(node) {
			const num = Number(node.value);
			return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
		}
	};
	const float = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
		resolve(str) {
			const node = new Scalar.Scalar(parseFloat(str));
			const dot = str.indexOf(".");
			if (dot !== -1 && str[str.length - 1] === "0") node.minFractionDigits = str.length - dot - 1;
			return node;
		},
		stringify: stringifyNumber.stringifyNumber
	};
	exports.float = float;
	exports.floatExp = floatExp;
	exports.floatNaN = floatNaN;
}));

// node_modules/yaml/dist/schema/core/int.js
var require_int$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var stringifyNumber = require_stringifyNumber();
	const intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
	const intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
	function intStringify(node, radix, prefix) {
		const { value } = node;
		if (intIdentify(value) && value >= 0) return prefix + value.toString(radix);
		return stringifyNumber.stringifyNumber(node);
	}
	const intOct = {
		identify: (value) => intIdentify(value) && value >= 0,
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "OCT",
		test: /^0o[0-7]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
		stringify: (node) => intStringify(node, 8, "0o")
	};
	const int = {
		identify: intIdentify,
		default: true,
		tag: "tag:yaml.org,2002:int",
		test: /^[-+]?[0-9]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
		stringify: stringifyNumber.stringifyNumber
	};
	const intHex = {
		identify: (value) => intIdentify(value) && value >= 0,
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "HEX",
		test: /^0x[0-9a-fA-F]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
		stringify: (node) => intStringify(node, 16, "0x")
	};
	exports.int = int;
	exports.intHex = intHex;
	exports.intOct = intOct;
}));

// node_modules/yaml/dist/schema/core/schema.js
var require_schema$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var map = require_map();
	var _null = require_null();
	var seq = require_seq();
	var string = require_string();
	var bool = require_bool$1();
	var float = require_float$1();
	var int = require_int$1();
	const schema = [
		map.map,
		seq.seq,
		string.string,
		_null.nullTag,
		bool.boolTag,
		int.intOct,
		int.int,
		int.intHex,
		float.floatNaN,
		float.floatExp,
		float.float
	];
	exports.schema = schema;
}));

// node_modules/yaml/dist/schema/json/schema.js
var require_schema$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	var map = require_map();
	var seq = require_seq();
	function intIdentify(value) {
		return typeof value === "bigint" || Number.isInteger(value);
	}
	const stringifyJSON = ({ value }) => JSON.stringify(value);
	const jsonScalars = [
		{
			identify: (value) => typeof value === "string",
			default: true,
			tag: "tag:yaml.org,2002:str",
			resolve: (str) => str,
			stringify: stringifyJSON
		},
		{
			identify: (value) => value == null,
			createNode: () => new Scalar.Scalar(null),
			default: true,
			tag: "tag:yaml.org,2002:null",
			test: /^null$/,
			resolve: () => null,
			stringify: stringifyJSON
		},
		{
			identify: (value) => typeof value === "boolean",
			default: true,
			tag: "tag:yaml.org,2002:bool",
			test: /^true$|^false$/,
			resolve: (str) => str === "true",
			stringify: stringifyJSON
		},
		{
			identify: intIdentify,
			default: true,
			tag: "tag:yaml.org,2002:int",
			test: /^-?(?:0|[1-9][0-9]*)$/,
			resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
			stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
		},
		{
			identify: (value) => typeof value === "number",
			default: true,
			tag: "tag:yaml.org,2002:float",
			test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
			resolve: (str) => parseFloat(str),
			stringify: stringifyJSON
		}
	];
	const schema = [map.map, seq.seq].concat(jsonScalars, {
		default: true,
		tag: "",
		test: /^/,
		resolve(str, onError) {
			onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
			return str;
		}
	});
	exports.schema = schema;
}));

// node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = /* @__PURE__ */ __commonJSMin(((exports) => {
	var node_buffer = __require("buffer");
	var Scalar = require_Scalar();
	var stringifyString = require_stringifyString();
	const binary = {
		identify: (value) => value instanceof Uint8Array,
		default: false,
		tag: "tag:yaml.org,2002:binary",
		/**
		* Returns a Buffer in node and an Uint8Array in browsers
		*
		* To use the resulting buffer as an image, you'll want to do something like:
		*
		*   const blob = new Blob([buffer], { type: 'image/jpeg' })
		*   document.querySelector('#photo').src = URL.createObjectURL(blob)
		*/
		resolve(src, onError) {
			if (typeof node_buffer.Buffer === "function") return node_buffer.Buffer.from(src, "base64");
			else if (typeof atob === "function") {
				const str = atob(src.replace(/[\n\r]/g, ""));
				const buffer = new Uint8Array(str.length);
				for (let i = 0; i < str.length; ++i) buffer[i] = str.charCodeAt(i);
				return buffer;
			} else {
				onError("This environment does not support reading binary tags; either Buffer or atob is required");
				return src;
			}
		},
		stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
			if (!value) return "";
			const buf = value;
			let str;
			if (typeof node_buffer.Buffer === "function") str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
			else if (typeof btoa === "function") {
				let s = "";
				for (let i = 0; i < buf.length; ++i) s += String.fromCharCode(buf[i]);
				str = btoa(s);
			} else throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
			type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
			if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
				const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
				const n = Math.ceil(str.length / lineWidth);
				const lines = new Array(n);
				for (let i = 0, o = 0; i < n; ++i, o += lineWidth) lines[i] = str.substr(o, lineWidth);
				str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
			}
			return stringifyString.stringifyString({
				comment,
				type,
				value: str
			}, ctx, onComment, onChompKeep);
		}
	};
	exports.binary = binary;
}));

// node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Pair = require_Pair();
	var Scalar = require_Scalar();
	var YAMLSeq = require_YAMLSeq();
	function resolvePairs(seq, onError) {
		if (identity.isSeq(seq)) for (let i = 0; i < seq.items.length; ++i) {
			let item = seq.items[i];
			if (identity.isPair(item)) continue;
			else if (identity.isMap(item)) {
				if (item.items.length > 1) onError("Each pair must have its own sequence indicator");
				const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
				if (item.commentBefore) pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}\n${pair.key.commentBefore}` : item.commentBefore;
				if (item.comment) {
					const cn = pair.value ?? pair.key;
					cn.comment = cn.comment ? `${item.comment}\n${cn.comment}` : item.comment;
				}
				item = pair;
			}
			seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
		}
		else onError("Expected a sequence for this tag");
		return seq;
	}
	function createPairs(schema, iterable, ctx) {
		const { replacer } = ctx;
		const pairs = new YAMLSeq.YAMLSeq(schema);
		pairs.tag = "tag:yaml.org,2002:pairs";
		let i = 0;
		if (iterable && Symbol.iterator in Object(iterable)) for (let it of iterable) {
			if (typeof replacer === "function") it = replacer.call(iterable, String(i++), it);
			let key, value;
			if (Array.isArray(it)) {
				if (it.length === 2) {
					key = it[0];
					value = it[1];
				} else throw new TypeError(`Expected [key, value] tuple: ${it}`);
			} else if (it && it instanceof Object) {
				const keys = Object.keys(it);
				if (keys.length === 1) {
					key = keys[0];
					value = it[key];
				} else throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
			} else key = it;
			pairs.items.push(Pair.createPair(key, value, ctx));
		}
		return pairs;
	}
	const pairs = {
		collection: "seq",
		default: false,
		tag: "tag:yaml.org,2002:pairs",
		resolve: resolvePairs,
		createNode: createPairs
	};
	exports.createPairs = createPairs;
	exports.pairs = pairs;
	exports.resolvePairs = resolvePairs;
}));

// node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var toJS = require_toJS();
	var YAMLMap = require_YAMLMap();
	var YAMLSeq = require_YAMLSeq();
	var pairs = require_pairs();
	var YAMLOMap = class YAMLOMap extends YAMLSeq.YAMLSeq {
		constructor() {
			super();
			this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
			this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
			this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
			this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
			this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
			this.tag = YAMLOMap.tag;
		}
		/**
		* If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
		* but TypeScript won't allow widening the signature of a child method.
		*/
		toJSON(_, ctx) {
			if (!ctx) return super.toJSON(_);
			const map = /* @__PURE__ */ new Map();
			if (ctx?.onCreate) ctx.onCreate(map);
			for (const pair of this.items) {
				let key, value;
				if (identity.isPair(pair)) {
					key = toJS.toJS(pair.key, "", ctx);
					value = toJS.toJS(pair.value, key, ctx);
				} else key = toJS.toJS(pair, "", ctx);
				if (map.has(key)) throw new Error("Ordered maps must not include duplicate keys");
				map.set(key, value);
			}
			return map;
		}
		static from(schema, iterable, ctx) {
			const pairs$1 = pairs.createPairs(schema, iterable, ctx);
			const omap = new this();
			omap.items = pairs$1.items;
			return omap;
		}
	};
	YAMLOMap.tag = "tag:yaml.org,2002:omap";
	const omap = {
		collection: "seq",
		identify: (value) => value instanceof Map,
		nodeClass: YAMLOMap,
		default: false,
		tag: "tag:yaml.org,2002:omap",
		resolve(seq, onError) {
			const pairs$1 = pairs.resolvePairs(seq, onError);
			const seenKeys = [];
			for (const { key } of pairs$1.items) if (identity.isScalar(key)) {
				if (seenKeys.includes(key.value)) onError(`Ordered maps must not include duplicate keys: ${key.value}`);
				else seenKeys.push(key.value);
			}
			return Object.assign(new YAMLOMap(), pairs$1);
		},
		createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
	};
	exports.YAMLOMap = YAMLOMap;
	exports.omap = omap;
}));

// node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	function boolStringify({ value, source }, ctx) {
		if (source && (value ? trueTag : falseTag).test.test(source)) return source;
		return value ? ctx.options.trueStr : ctx.options.falseStr;
	}
	const trueTag = {
		identify: (value) => value === true,
		default: true,
		tag: "tag:yaml.org,2002:bool",
		test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
		resolve: () => new Scalar.Scalar(true),
		stringify: boolStringify
	};
	const falseTag = {
		identify: (value) => value === false,
		default: true,
		tag: "tag:yaml.org,2002:bool",
		test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
		resolve: () => new Scalar.Scalar(false),
		stringify: boolStringify
	};
	exports.falseTag = falseTag;
	exports.trueTag = trueTag;
}));

// node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	var stringifyNumber = require_stringifyNumber();
	const floatNaN = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
		resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
		stringify: stringifyNumber.stringifyNumber
	};
	const floatExp = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		format: "EXP",
		test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
		resolve: (str) => parseFloat(str.replace(/_/g, "")),
		stringify(node) {
			const num = Number(node.value);
			return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
		}
	};
	const float = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
		resolve(str) {
			const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
			const dot = str.indexOf(".");
			if (dot !== -1) {
				const f = str.substring(dot + 1).replace(/_/g, "");
				if (f[f.length - 1] === "0") node.minFractionDigits = f.length;
			}
			return node;
		},
		stringify: stringifyNumber.stringifyNumber
	};
	exports.float = float;
	exports.floatExp = floatExp;
	exports.floatNaN = floatNaN;
}));

// node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int = /* @__PURE__ */ __commonJSMin(((exports) => {
	var stringifyNumber = require_stringifyNumber();
	const intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
	function intResolve(str, offset, radix, { intAsBigInt }) {
		const sign = str[0];
		if (sign === "-" || sign === "+") offset += 1;
		str = str.substring(offset).replace(/_/g, "");
		if (intAsBigInt) {
			switch (radix) {
				case 2:
					str = `0b${str}`;
					break;
				case 8:
					str = `0o${str}`;
					break;
				case 16: str = `0x${str}`;
			}
			const n = BigInt(str);
			return sign === "-" ? BigInt(-1) * n : n;
		}
		const n = parseInt(str, radix);
		return sign === "-" ? -1 * n : n;
	}
	function intStringify(node, radix, prefix) {
		const { value } = node;
		if (intIdentify(value)) {
			const str = value.toString(radix);
			return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
		}
		return stringifyNumber.stringifyNumber(node);
	}
	const intBin = {
		identify: intIdentify,
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "BIN",
		test: /^[-+]?0b[0-1_]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
		stringify: (node) => intStringify(node, 2, "0b")
	};
	const intOct = {
		identify: intIdentify,
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "OCT",
		test: /^[-+]?0[0-7_]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
		stringify: (node) => intStringify(node, 8, "0")
	};
	const int = {
		identify: intIdentify,
		default: true,
		tag: "tag:yaml.org,2002:int",
		test: /^[-+]?[0-9][0-9_]*$/,
		resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
		stringify: stringifyNumber.stringifyNumber
	};
	const intHex = {
		identify: intIdentify,
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "HEX",
		test: /^[-+]?0x[0-9a-fA-F_]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
		stringify: (node) => intStringify(node, 16, "0x")
	};
	exports.int = int;
	exports.intBin = intBin;
	exports.intHex = intHex;
	exports.intOct = intOct;
}));

// node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Pair = require_Pair();
	var YAMLMap = require_YAMLMap();
	var YAMLSet = class YAMLSet extends YAMLMap.YAMLMap {
		constructor(schema) {
			super(schema);
			this.tag = YAMLSet.tag;
		}
		add(key) {
			let pair;
			if (identity.isPair(key)) pair = key;
			else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null) pair = new Pair.Pair(key.key, null);
			else pair = new Pair.Pair(key, null);
			if (!YAMLMap.findPair(this.items, pair.key)) this.items.push(pair);
		}
		/**
		* If `keepPair` is `true`, returns the Pair matching `key`.
		* Otherwise, returns the value of that Pair's key.
		*/
		get(key, keepPair) {
			const pair = YAMLMap.findPair(this.items, key);
			return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
		}
		set(key, value) {
			if (typeof value !== "boolean") throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
			const prev = YAMLMap.findPair(this.items, key);
			if (prev && !value) this.items.splice(this.items.indexOf(prev), 1);
			else if (!prev && value) this.items.push(new Pair.Pair(key));
		}
		toJSON(_, ctx) {
			return super.toJSON(_, ctx, Set);
		}
		toString(ctx, onComment, onChompKeep) {
			if (!ctx) return JSON.stringify(this);
			if (this.hasAllNullValues(true)) return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
			else throw new Error("Set items must all have null values");
		}
		static from(schema, iterable, ctx) {
			const { replacer } = ctx;
			const set = new this(schema);
			if (iterable && Symbol.iterator in Object(iterable)) for (let value of iterable) {
				if (typeof replacer === "function") value = replacer.call(iterable, value, value);
				set.items.push(Pair.createPair(value, null, ctx));
			}
			return set;
		}
	};
	YAMLSet.tag = "tag:yaml.org,2002:set";
	const set = {
		collection: "map",
		identify: (value) => value instanceof Set,
		nodeClass: YAMLSet,
		default: false,
		tag: "tag:yaml.org,2002:set",
		createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
		resolve(map, onError) {
			if (identity.isMap(map)) {
				if (map.hasAllNullValues(true)) return Object.assign(new YAMLSet(), map);
				else onError("Set items must all have null values");
			} else onError("Expected a mapping for this tag");
			return map;
		}
	};
	exports.YAMLSet = YAMLSet;
	exports.set = set;
}));

// node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = /* @__PURE__ */ __commonJSMin(((exports) => {
	var stringifyNumber = require_stringifyNumber();
	/** Internal types handle bigint as number, because TS can't figure it out. */
	function parseSexagesimal(str, asBigInt) {
		const sign = str[0];
		const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
		const num = (n) => asBigInt ? BigInt(n) : Number(n);
		const res = parts.replace(/_/g, "").split(":").reduce((res, p) => res * num(60) + num(p), num(0));
		return sign === "-" ? num(-1) * res : res;
	}
	/**
	* hhhh:mm:ss.sss
	*
	* Internal types handle bigint as number, because TS can't figure it out.
	*/
	function stringifySexagesimal(node) {
		let { value } = node;
		let num = (n) => n;
		if (typeof value === "bigint") num = (n) => BigInt(n);
		else if (isNaN(value) || !isFinite(value)) return stringifyNumber.stringifyNumber(node);
		let sign = "";
		if (value < 0) {
			sign = "-";
			value *= num(-1);
		}
		const _60 = num(60);
		const parts = [value % _60];
		if (value < 60) parts.unshift(0);
		else {
			value = (value - parts[0]) / _60;
			parts.unshift(value % _60);
			if (value >= 60) {
				value = (value - parts[0]) / _60;
				parts.unshift(value);
			}
		}
		return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
	}
	const intTime = {
		identify: (value) => typeof value === "bigint" || Number.isInteger(value),
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "TIME",
		test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
		resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
		stringify: stringifySexagesimal
	};
	const floatTime = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		format: "TIME",
		test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
		resolve: (str) => parseSexagesimal(str, false),
		stringify: stringifySexagesimal
	};
	const timestamp = {
		identify: (value) => value instanceof Date,
		default: true,
		tag: "tag:yaml.org,2002:timestamp",
		test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
		resolve(str) {
			const match = str.match(timestamp.test);
			if (!match) throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
			const [, year, month, day, hour, minute, second] = match.map(Number);
			const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
			let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
			const tz = match[8];
			if (tz && tz !== "Z") {
				let d = parseSexagesimal(tz, false);
				if (Math.abs(d) < 30) d *= 60;
				date -= 6e4 * d;
			}
			return new Date(date);
		},
		stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
	};
	exports.floatTime = floatTime;
	exports.intTime = intTime;
	exports.timestamp = timestamp;
}));

// node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema = /* @__PURE__ */ __commonJSMin(((exports) => {
	var map = require_map();
	var _null = require_null();
	var seq = require_seq();
	var string = require_string();
	var binary = require_binary();
	var bool = require_bool();
	var float = require_float();
	var int = require_int();
	var merge = require_merge();
	var omap = require_omap();
	var pairs = require_pairs();
	var set = require_set();
	var timestamp = require_timestamp();
	const schema = [
		map.map,
		seq.seq,
		string.string,
		_null.nullTag,
		bool.trueTag,
		bool.falseTag,
		int.intBin,
		int.intOct,
		int.int,
		int.intHex,
		float.floatNaN,
		float.floatExp,
		float.float,
		binary.binary,
		merge.merge,
		omap.omap,
		pairs.pairs,
		set.set,
		timestamp.intTime,
		timestamp.floatTime,
		timestamp.timestamp
	];
	exports.schema = schema;
}));

// node_modules/yaml/dist/schema/tags.js
var require_tags = /* @__PURE__ */ __commonJSMin(((exports) => {
	var map = require_map();
	var _null = require_null();
	var seq = require_seq();
	var string = require_string();
	var bool = require_bool$1();
	var float = require_float$1();
	var int = require_int$1();
	var schema = require_schema$2();
	var schema$1 = require_schema$1();
	var binary = require_binary();
	var merge = require_merge();
	var omap = require_omap();
	var pairs = require_pairs();
	var schema$2 = require_schema();
	var set = require_set();
	var timestamp = require_timestamp();
	const schemas = /* @__PURE__ */ new Map([
		["core", schema.schema],
		["failsafe", [
			map.map,
			seq.seq,
			string.string
		]],
		["json", schema$1.schema],
		["yaml11", schema$2.schema],
		["yaml-1.1", schema$2.schema]
	]);
	const tagsByName = {
		binary: binary.binary,
		bool: bool.boolTag,
		float: float.float,
		floatExp: float.floatExp,
		floatNaN: float.floatNaN,
		floatTime: timestamp.floatTime,
		int: int.int,
		intHex: int.intHex,
		intOct: int.intOct,
		intTime: timestamp.intTime,
		map: map.map,
		merge: merge.merge,
		null: _null.nullTag,
		omap: omap.omap,
		pairs: pairs.pairs,
		seq: seq.seq,
		set: set.set,
		timestamp: timestamp.timestamp
	};
	const coreKnownTags = {
		"tag:yaml.org,2002:binary": binary.binary,
		"tag:yaml.org,2002:merge": merge.merge,
		"tag:yaml.org,2002:omap": omap.omap,
		"tag:yaml.org,2002:pairs": pairs.pairs,
		"tag:yaml.org,2002:set": set.set,
		"tag:yaml.org,2002:timestamp": timestamp.timestamp
	};
	function getTags(customTags, schemaName, addMergeTag) {
		const schemaTags = schemas.get(schemaName);
		if (schemaTags && !customTags) return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
		let tags = schemaTags;
		if (!tags) {
			if (Array.isArray(customTags)) tags = [];
			else {
				const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
				throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
			}
		}
		if (Array.isArray(customTags)) for (const tag of customTags) tags = tags.concat(tag);
		else if (typeof customTags === "function") tags = customTags(tags.slice());
		if (addMergeTag) tags = tags.concat(merge.merge);
		return tags.reduce((tags, tag) => {
			const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
			if (!tagObj) {
				const tagName = JSON.stringify(tag);
				const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
				throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
			}
			if (!tags.includes(tagObj)) tags.push(tagObj);
			return tags;
		}, []);
	}
	exports.coreKnownTags = coreKnownTags;
	exports.getTags = getTags;
}));

// node_modules/yaml/dist/schema/Schema.js
var require_Schema = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var map = require_map();
	var seq = require_seq();
	var string = require_string();
	var tags = require_tags();
	const sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	var Schema = class Schema {
		constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
			this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
			this.name = typeof schema === "string" && schema || "core";
			this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
			this.tags = tags.getTags(customTags, this.name, merge);
			this.toStringOptions = toStringDefaults ?? null;
			Object.defineProperty(this, identity.MAP, { value: map.map });
			Object.defineProperty(this, identity.SCALAR, { value: string.string });
			Object.defineProperty(this, identity.SEQ, { value: seq.seq });
			this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
		}
		clone() {
			const copy = Object.create(Schema.prototype, Object.getOwnPropertyDescriptors(this));
			copy.tags = this.tags.slice();
			return copy;
		}
	};
	exports.Schema = Schema;
}));

// node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var stringify = require_stringify();
	var stringifyComment = require_stringifyComment();
	function stringifyDocument(doc, options) {
		const lines = [];
		let hasDirectives = options.directives === true;
		if (options.directives !== false && doc.directives) {
			const dir = doc.directives.toString(doc);
			if (dir) {
				lines.push(dir);
				hasDirectives = true;
			} else if (doc.directives.docStart) hasDirectives = true;
		}
		if (hasDirectives) lines.push("---");
		const ctx = stringify.createStringifyContext(doc, options);
		const { commentString } = ctx.options;
		if (doc.commentBefore) {
			if (lines.length !== 1) lines.unshift("");
			const cs = commentString(doc.commentBefore);
			lines.unshift(stringifyComment.indentComment(cs, ""));
		}
		let chompKeep = false;
		let contentComment = null;
		if (doc.contents) {
			if (identity.isNode(doc.contents)) {
				if (doc.contents.spaceBefore && hasDirectives) lines.push("");
				if (doc.contents.commentBefore) {
					const cs = commentString(doc.contents.commentBefore);
					lines.push(stringifyComment.indentComment(cs, ""));
				}
				ctx.forceBlockIndent = !!doc.comment;
				contentComment = doc.contents.comment;
			}
			const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
			let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
			if (contentComment) body += stringifyComment.lineComment(body, "", commentString(contentComment));
			if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") lines[lines.length - 1] = `--- ${body}`;
			else lines.push(body);
		} else lines.push(stringify.stringify(doc.contents, ctx));
		if (doc.directives?.docEnd) {
			if (doc.comment) {
				const cs = commentString(doc.comment);
				if (cs.includes("\n")) {
					lines.push("...");
					lines.push(stringifyComment.indentComment(cs, ""));
				} else lines.push(`... ${cs}`);
			} else lines.push("...");
		} else {
			let dc = doc.comment;
			if (dc && chompKeep) dc = dc.replace(/^\n+/, "");
			if (dc) {
				if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "") lines.push("");
				lines.push(stringifyComment.indentComment(commentString(dc), ""));
			}
		}
		return lines.join("\n") + "\n";
	}
	exports.stringifyDocument = stringifyDocument;
}));

// node_modules/yaml/dist/doc/Document.js
var require_Document = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Alias = require_Alias();
	var Collection = require_Collection();
	var identity = require_identity();
	var Pair = require_Pair();
	var toJS = require_toJS();
	var Schema = require_Schema();
	var stringifyDocument = require_stringifyDocument();
	var anchors = require_anchors();
	var applyReviver = require_applyReviver();
	var createNode = require_createNode();
	var directives = require_directives();
	var Document = class Document {
		constructor(value, replacer, options) {
			/** A comment before this Document */
			this.commentBefore = null;
			/** A comment immediately after this Document */
			this.comment = null;
			/** Errors encountered during parsing. */
			this.errors = [];
			/** Warnings encountered during parsing. */
			this.warnings = [];
			Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
			let _replacer = null;
			if (typeof replacer === "function" || Array.isArray(replacer)) _replacer = replacer;
			else if (options === void 0 && replacer) {
				options = replacer;
				replacer = void 0;
			}
			const opt = Object.assign({
				intAsBigInt: false,
				keepSourceTokens: false,
				logLevel: "warn",
				prettyErrors: true,
				strict: true,
				stringKeys: false,
				uniqueKeys: true,
				version: "1.2"
			}, options);
			this.options = opt;
			let { version } = opt;
			if (options?._directives) {
				this.directives = options._directives.atDocument();
				if (this.directives.yaml.explicit) version = this.directives.yaml.version;
			} else this.directives = new directives.Directives({ version });
			this.setSchema(version, options);
			this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
		}
		/**
		* Create a deep copy of this Document and its contents.
		*
		* Custom Node values that inherit from `Object` still refer to their original instances.
		*/
		clone() {
			const copy = Object.create(Document.prototype, { [identity.NODE_TYPE]: { value: identity.DOC } });
			copy.commentBefore = this.commentBefore;
			copy.comment = this.comment;
			copy.errors = this.errors.slice();
			copy.warnings = this.warnings.slice();
			copy.options = Object.assign({}, this.options);
			if (this.directives) copy.directives = this.directives.clone();
			copy.schema = this.schema.clone();
			copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
			if (this.range) copy.range = this.range.slice();
			return copy;
		}
		/** Adds a value to the document. */
		add(value) {
			if (assertCollection(this.contents)) this.contents.add(value);
		}
		/** Adds a value to the document. */
		addIn(path, value) {
			if (assertCollection(this.contents)) this.contents.addIn(path, value);
		}
		/**
		* Create a new `Alias` node, ensuring that the target `node` has the required anchor.
		*
		* If `node` already has an anchor, `name` is ignored.
		* Otherwise, the `node.anchor` value will be set to `name`,
		* or if an anchor with that name is already present in the document,
		* `name` will be used as a prefix for a new unique anchor.
		* If `name` is undefined, the generated anchor will use 'a' as a prefix.
		*/
		createAlias(node, name) {
			if (!node.anchor) {
				const prev = anchors.anchorNames(this);
				node.anchor = !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
			}
			return new Alias.Alias(node.anchor);
		}
		createNode(value, replacer, options) {
			let _replacer = void 0;
			if (typeof replacer === "function") {
				value = replacer.call({ "": value }, "", value);
				_replacer = replacer;
			} else if (Array.isArray(replacer)) {
				const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
				const asStr = replacer.filter(keyToStr).map(String);
				if (asStr.length > 0) replacer = replacer.concat(asStr);
				_replacer = replacer;
			} else if (options === void 0 && replacer) {
				options = replacer;
				replacer = void 0;
			}
			const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
			const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(this, anchorPrefix || "a");
			const ctx = {
				aliasDuplicateObjects: aliasDuplicateObjects ?? true,
				keepUndefined: keepUndefined ?? false,
				onAnchor,
				onTagObj,
				replacer: _replacer,
				schema: this.schema,
				sourceObjects
			};
			const node = createNode.createNode(value, tag, ctx);
			if (flow && identity.isCollection(node)) node.flow = true;
			setAnchors();
			return node;
		}
		/**
		* Convert a key and a value into a `Pair` using the current schema,
		* recursively wrapping all values as `Scalar` or `Collection` nodes.
		*/
		createPair(key, value, options = {}) {
			const k = this.createNode(key, null, options);
			const v = this.createNode(value, null, options);
			return new Pair.Pair(k, v);
		}
		/**
		* Removes a value from the document.
		* @returns `true` if the item was found and removed.
		*/
		delete(key) {
			return assertCollection(this.contents) ? this.contents.delete(key) : false;
		}
		/**
		* Removes a value from the document.
		* @returns `true` if the item was found and removed.
		*/
		deleteIn(path) {
			if (Collection.isEmptyPath(path)) {
				if (this.contents == null) return false;
				this.contents = null;
				return true;
			}
			return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
		}
		/**
		* Returns item at `key`, or `undefined` if not found. By default unwraps
		* scalar values from their surrounding node; to disable set `keepScalar` to
		* `true` (collections are always returned intact).
		*/
		get(key, keepScalar) {
			return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
		}
		/**
		* Returns item at `path`, or `undefined` if not found. By default unwraps
		* scalar values from their surrounding node; to disable set `keepScalar` to
		* `true` (collections are always returned intact).
		*/
		getIn(path, keepScalar) {
			if (Collection.isEmptyPath(path)) return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
			return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
		}
		/**
		* Checks if the document includes a value with the key `key`.
		*/
		has(key) {
			return identity.isCollection(this.contents) ? this.contents.has(key) : false;
		}
		/**
		* Checks if the document includes a value at `path`.
		*/
		hasIn(path) {
			if (Collection.isEmptyPath(path)) return this.contents !== void 0;
			return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
		}
		/**
		* Sets a value in this document. For `!!set`, `value` needs to be a
		* boolean to add/remove the item from the set.
		*/
		set(key, value) {
			if (this.contents == null) this.contents = Collection.collectionFromPath(this.schema, [key], value);
			else if (assertCollection(this.contents)) this.contents.set(key, value);
		}
		/**
		* Sets a value in this document. For `!!set`, `value` needs to be a
		* boolean to add/remove the item from the set.
		*/
		setIn(path, value) {
			if (Collection.isEmptyPath(path)) this.contents = value;
			else if (this.contents == null) this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
			else if (assertCollection(this.contents)) this.contents.setIn(path, value);
		}
		/**
		* Change the YAML version and schema used by the document.
		* A `null` version disables support for directives, explicit tags, anchors, and aliases.
		* It also requires the `schema` option to be given as a `Schema` instance value.
		*
		* Overrides all previously set schema options.
		*/
		setSchema(version, options = {}) {
			if (typeof version === "number") version = String(version);
			let opt;
			switch (version) {
				case "1.1":
					if (this.directives) this.directives.yaml.version = "1.1";
					else this.directives = new directives.Directives({ version: "1.1" });
					opt = {
						resolveKnownTags: false,
						schema: "yaml-1.1"
					};
					break;
				case "1.2":
				case "next":
					if (this.directives) this.directives.yaml.version = version;
					else this.directives = new directives.Directives({ version });
					opt = {
						resolveKnownTags: true,
						schema: "core"
					};
					break;
				case null:
					if (this.directives) delete this.directives;
					opt = null;
					break;
				default: {
					const sv = JSON.stringify(version);
					throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
				}
			}
			if (options.schema instanceof Object) this.schema = options.schema;
			else if (opt) this.schema = new Schema.Schema(Object.assign(opt, options));
			else throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
		}
		toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
			const ctx = {
				anchors: /* @__PURE__ */ new Map(),
				doc: this,
				keep: !json,
				mapAsMap: mapAsMap === true,
				mapKeyWarned: false,
				maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
			};
			const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
			if (typeof onAnchor === "function") for (const { count, res } of ctx.anchors.values()) onAnchor(res, count);
			return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
		}
		/**
		* A JSON representation of the document `contents`.
		*
		* @param jsonArg Used by `JSON.stringify` to indicate the array index or
		*   property name.
		*/
		toJSON(jsonArg, onAnchor) {
			return this.toJS({
				json: true,
				jsonArg,
				mapAsMap: false,
				onAnchor
			});
		}
		/** A YAML representation of the document. */
		toString(options = {}) {
			if (this.errors.length > 0) throw new Error("Document with errors cannot be stringified");
			if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
				const s = JSON.stringify(options.indent);
				throw new Error(`"indent" option must be a positive integer, not ${s}`);
			}
			return stringifyDocument.stringifyDocument(this, options);
		}
	};
	function assertCollection(contents) {
		if (identity.isCollection(contents)) return true;
		throw new Error("Expected a YAML collection as document contents");
	}
	exports.Document = Document;
}));

// node_modules/yaml/dist/errors.js
var require_errors = /* @__PURE__ */ __commonJSMin(((exports) => {
	var YAMLError = class extends Error {
		constructor(name, pos, code, message) {
			super();
			this.name = name;
			this.code = code;
			this.message = message;
			this.pos = pos;
		}
	};
	var YAMLParseError = class extends YAMLError {
		constructor(pos, code, message) {
			super("YAMLParseError", pos, code, message);
		}
	};
	var YAMLWarning = class extends YAMLError {
		constructor(pos, code, message) {
			super("YAMLWarning", pos, code, message);
		}
	};
	const prettifyError = (src, lc) => (error) => {
		if (error.pos[0] === -1) return;
		error.linePos = error.pos.map((pos) => lc.linePos(pos));
		const { line, col } = error.linePos[0];
		error.message += ` at line ${line}, column ${col}`;
		let ci = col - 1;
		let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
		if (ci >= 60 && lineStr.length > 80) {
			const trimStart = Math.min(ci - 39, lineStr.length - 79);
			lineStr = "…" + lineStr.substring(trimStart);
			ci -= trimStart - 1;
		}
		if (lineStr.length > 80) lineStr = lineStr.substring(0, 79) + "…";
		if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
			let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
			if (prev.length > 80) prev = prev.substring(0, 79) + "…\n";
			lineStr = prev + lineStr;
		}
		if (/[^ ]/.test(lineStr)) {
			let count = 1;
			const end = error.linePos[1];
			if (end?.line === line && end.col > col) count = Math.max(1, Math.min(end.col - col, 80 - ci));
			const pointer = " ".repeat(ci) + "^".repeat(count);
			error.message += `:\n\n${lineStr}\n${pointer}\n`;
		}
	};
	exports.YAMLError = YAMLError;
	exports.YAMLParseError = YAMLParseError;
	exports.YAMLWarning = YAMLWarning;
	exports.prettifyError = prettifyError;
}));

// node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = /* @__PURE__ */ __commonJSMin(((exports) => {
	function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
		let spaceBefore = false;
		let atNewline = startOnNewline;
		let hasSpace = startOnNewline;
		let comment = "";
		let commentSep = "";
		let hasNewline = false;
		let reqSpace = false;
		let tab = null;
		let anchor = null;
		let tag = null;
		let newlineAfterProp = null;
		let comma = null;
		let found = null;
		let start = null;
		for (const token of tokens) {
			if (reqSpace) {
				if (token.type !== "space" && token.type !== "newline" && token.type !== "comma") onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
				reqSpace = false;
			}
			if (tab) {
				if (atNewline && token.type !== "comment" && token.type !== "newline") onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
				tab = null;
			}
			switch (token.type) {
				case "space":
					if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) tab = token;
					hasSpace = true;
					break;
				case "comment": {
					if (!hasSpace) onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
					const cb = token.source.substring(1) || " ";
					if (!comment) comment = cb;
					else comment += commentSep + cb;
					commentSep = "";
					atNewline = false;
					break;
				}
				case "newline":
					if (atNewline) {
						if (comment) comment += token.source;
						else if (!found || indicator !== "seq-item-ind") spaceBefore = true;
					} else commentSep += token.source;
					atNewline = true;
					hasNewline = true;
					if (anchor || tag) newlineAfterProp = token;
					hasSpace = true;
					break;
				case "anchor":
					if (anchor) onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
					if (token.source.endsWith(":")) onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
					anchor = token;
					start ?? (start = token.offset);
					atNewline = false;
					hasSpace = false;
					reqSpace = true;
					break;
				case "tag":
					if (tag) onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
					tag = token;
					start ?? (start = token.offset);
					atNewline = false;
					hasSpace = false;
					reqSpace = true;
					break;
				case indicator:
					if (anchor || tag) onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
					if (found) onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
					found = token;
					atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
					hasSpace = false;
					break;
				case "comma": if (flow) {
					if (comma) onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
					comma = token;
					atNewline = false;
					hasSpace = false;
					break;
				}
				default:
					onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
					atNewline = false;
					hasSpace = false;
			}
		}
		const last = tokens[tokens.length - 1];
		const end = last ? last.offset + last.source.length : offset;
		if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
		if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq")) onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
		return {
			comma,
			found,
			spaceBefore,
			comment,
			hasNewline,
			anchor,
			tag,
			newlineAfterProp,
			end,
			start: start ?? end
		};
	}
	exports.resolveProps = resolveProps;
}));

// node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = /* @__PURE__ */ __commonJSMin(((exports) => {
	function containsNewline(key) {
		if (!key) return null;
		switch (key.type) {
			case "alias":
			case "scalar":
			case "double-quoted-scalar":
			case "single-quoted-scalar":
				if (key.source.includes("\n")) return true;
				if (key.end) {
					for (const st of key.end) if (st.type === "newline") return true;
				}
				return false;
			case "flow-collection":
				for (const it of key.items) {
					for (const st of it.start) if (st.type === "newline") return true;
					if (it.sep) {
						for (const st of it.sep) if (st.type === "newline") return true;
					}
					if (containsNewline(it.key) || containsNewline(it.value)) return true;
				}
				return false;
			default: return true;
		}
	}
	exports.containsNewline = containsNewline;
}));

// node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = /* @__PURE__ */ __commonJSMin(((exports) => {
	var utilContainsNewline = require_util_contains_newline();
	function flowIndentCheck(indent, fc, onError) {
		if (fc?.type === "flow-collection") {
			const end = fc.end[0];
			if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) onError(end, "BAD_INDENT", "Flow end indicator should be more indented than parent", true);
		}
	}
	exports.flowIndentCheck = flowIndentCheck;
}));

// node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	function mapIncludes(ctx, items, search) {
		const { uniqueKeys } = ctx.options;
		if (uniqueKeys === false) return false;
		const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
		return items.some((pair) => isEqual(pair.key, search));
	}
	exports.mapIncludes = mapIncludes;
}));

// node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Pair = require_Pair();
	var YAMLMap = require_YAMLMap();
	var resolveProps = require_resolve_props();
	var utilContainsNewline = require_util_contains_newline();
	var utilFlowIndentCheck = require_util_flow_indent_check();
	var utilMapIncludes = require_util_map_includes();
	const startColMsg = "All mapping items must start at the same column";
	function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
		const map = new ((tag?.nodeClass) ?? YAMLMap.YAMLMap)(ctx.schema);
		if (ctx.atRoot) ctx.atRoot = false;
		let offset = bm.offset;
		let commentEnd = null;
		for (const collItem of bm.items) {
			const { start, key, sep, value } = collItem;
			const keyProps = resolveProps.resolveProps(start, {
				indicator: "explicit-key-ind",
				next: key ?? sep?.[0],
				offset,
				onError,
				parentIndent: bm.indent,
				startOnNewline: true
			});
			const implicitKey = !keyProps.found;
			if (implicitKey) {
				if (key) {
					if (key.type === "block-seq") onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
					else if ("indent" in key && key.indent !== bm.indent) onError(offset, "BAD_INDENT", startColMsg);
				}
				if (!keyProps.anchor && !keyProps.tag && !sep) {
					commentEnd = keyProps.end;
					if (keyProps.comment) {
						if (map.comment) map.comment += "\n" + keyProps.comment;
						else map.comment = keyProps.comment;
					}
					continue;
				}
				if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
			} else if (keyProps.found?.indent !== bm.indent) onError(offset, "BAD_INDENT", startColMsg);
			ctx.atKey = true;
			const keyStart = keyProps.end;
			const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
			if (ctx.schema.compat) utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
			ctx.atKey = false;
			if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode)) onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
			const valueProps = resolveProps.resolveProps(sep ?? [], {
				indicator: "map-value-ind",
				next: value,
				offset: keyNode.range[2],
				onError,
				parentIndent: bm.indent,
				startOnNewline: !key || key.type === "block-scalar"
			});
			offset = valueProps.end;
			if (valueProps.found) {
				if (implicitKey) {
					if (value?.type === "block-map" && !valueProps.hasNewline) onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
					if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024) onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
				}
				const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep, null, valueProps, onError);
				if (ctx.schema.compat) utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
				offset = valueNode.range[2];
				const pair = new Pair.Pair(keyNode, valueNode);
				if (ctx.options.keepSourceTokens) pair.srcToken = collItem;
				map.items.push(pair);
			} else {
				if (implicitKey) onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
				if (valueProps.comment) {
					if (keyNode.comment) keyNode.comment += "\n" + valueProps.comment;
					else keyNode.comment = valueProps.comment;
				}
				const pair = new Pair.Pair(keyNode);
				if (ctx.options.keepSourceTokens) pair.srcToken = collItem;
				map.items.push(pair);
			}
		}
		if (commentEnd && commentEnd < offset) onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
		map.range = [
			bm.offset,
			offset,
			commentEnd ?? offset
		];
		return map;
	}
	exports.resolveBlockMap = resolveBlockMap;
}));

// node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = /* @__PURE__ */ __commonJSMin(((exports) => {
	var YAMLSeq = require_YAMLSeq();
	var resolveProps = require_resolve_props();
	var utilFlowIndentCheck = require_util_flow_indent_check();
	function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
		const seq = new ((tag?.nodeClass) ?? YAMLSeq.YAMLSeq)(ctx.schema);
		if (ctx.atRoot) ctx.atRoot = false;
		if (ctx.atKey) ctx.atKey = false;
		let offset = bs.offset;
		let commentEnd = null;
		for (const { start, value } of bs.items) {
			const props = resolveProps.resolveProps(start, {
				indicator: "seq-item-ind",
				next: value,
				offset,
				onError,
				parentIndent: bs.indent,
				startOnNewline: true
			});
			if (!props.found) {
				if (props.anchor || props.tag || value) {
					if (value?.type === "block-seq") onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
					else onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
				} else {
					commentEnd = props.end;
					if (props.comment) seq.comment = props.comment;
					continue;
				}
			}
			const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
			if (ctx.schema.compat) utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
			offset = node.range[2];
			seq.items.push(node);
		}
		seq.range = [
			bs.offset,
			offset,
			commentEnd ?? offset
		];
		return seq;
	}
	exports.resolveBlockSeq = resolveBlockSeq;
}));

// node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = /* @__PURE__ */ __commonJSMin(((exports) => {
	function resolveEnd(end, offset, reqSpace, onError) {
		let comment = "";
		if (end) {
			let hasSpace = false;
			let sep = "";
			for (const token of end) {
				const { source, type } = token;
				switch (type) {
					case "space":
						hasSpace = true;
						break;
					case "comment": {
						if (reqSpace && !hasSpace) onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
						const cb = source.substring(1) || " ";
						if (!comment) comment = cb;
						else comment += sep + cb;
						sep = "";
						break;
					}
					case "newline":
						if (comment) sep += source;
						hasSpace = true;
						break;
					default: onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
				}
				offset += source.length;
			}
		}
		return {
			comment,
			offset
		};
	}
	exports.resolveEnd = resolveEnd;
}));

// node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Pair = require_Pair();
	var YAMLMap = require_YAMLMap();
	var YAMLSeq = require_YAMLSeq();
	var resolveEnd = require_resolve_end();
	var resolveProps = require_resolve_props();
	var utilContainsNewline = require_util_contains_newline();
	var utilMapIncludes = require_util_map_includes();
	const blockMsg = "Block collections are not allowed within flow collections";
	const isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
	function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
		const isMap = fc.start.source === "{";
		const fcName = isMap ? "flow map" : "flow sequence";
		const coll = new ((tag?.nodeClass) ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq))(ctx.schema);
		coll.flow = true;
		const atRoot = ctx.atRoot;
		if (atRoot) ctx.atRoot = false;
		if (ctx.atKey) ctx.atKey = false;
		let offset = fc.offset + fc.start.source.length;
		for (let i = 0; i < fc.items.length; ++i) {
			const collItem = fc.items[i];
			const { start, key, sep, value } = collItem;
			const props = resolveProps.resolveProps(start, {
				flow: fcName,
				indicator: "explicit-key-ind",
				next: key ?? sep?.[0],
				offset,
				onError,
				parentIndent: fc.indent,
				startOnNewline: false
			});
			if (!props.found) {
				if (!props.anchor && !props.tag && !sep && !value) {
					if (i === 0 && props.comma) onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
					else if (i < fc.items.length - 1) onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
					if (props.comment) {
						if (coll.comment) coll.comment += "\n" + props.comment;
						else coll.comment = props.comment;
					}
					offset = props.end;
					continue;
				}
				if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key)) onError(key, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
			}
			if (i === 0) {
				if (props.comma) onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
			} else {
				if (!props.comma) onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
				if (props.comment) {
					let prevItemComment = "";
					loop: for (const st of start) switch (st.type) {
						case "comma":
						case "space": break;
						case "comment":
							prevItemComment = st.source.substring(1);
							break loop;
						default: break loop;
					}
					if (prevItemComment) {
						let prev = coll.items[coll.items.length - 1];
						if (identity.isPair(prev)) prev = prev.value ?? prev.key;
						if (prev.comment) prev.comment += "\n" + prevItemComment;
						else prev.comment = prevItemComment;
						props.comment = props.comment.substring(prevItemComment.length + 1);
					}
				}
			}
			if (!isMap && !sep && !props.found) {
				const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep, null, props, onError);
				coll.items.push(valueNode);
				offset = valueNode.range[2];
				if (isBlock(value)) onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
			} else {
				ctx.atKey = true;
				const keyStart = props.end;
				const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
				if (isBlock(key)) onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
				ctx.atKey = false;
				const valueProps = resolveProps.resolveProps(sep ?? [], {
					flow: fcName,
					indicator: "map-value-ind",
					next: value,
					offset: keyNode.range[2],
					onError,
					parentIndent: fc.indent,
					startOnNewline: false
				});
				if (valueProps.found) {
					if (!isMap && !props.found && ctx.options.strict) {
						if (sep) for (const st of sep) {
							if (st === valueProps.found) break;
							if (st.type === "newline") {
								onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
								break;
							}
						}
						if (props.start < valueProps.found.offset - 1024) onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
					}
				} else if (value) {
					if ("source" in value && value.source?.[0] === ":") onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
					else onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
				}
				const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep, null, valueProps, onError) : null;
				if (valueNode) {
					if (isBlock(value)) onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
				} else if (valueProps.comment) {
					if (keyNode.comment) keyNode.comment += "\n" + valueProps.comment;
					else keyNode.comment = valueProps.comment;
				}
				const pair = new Pair.Pair(keyNode, valueNode);
				if (ctx.options.keepSourceTokens) pair.srcToken = collItem;
				if (isMap) {
					const map = coll;
					if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode)) onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
					map.items.push(pair);
				} else {
					const map = new YAMLMap.YAMLMap(ctx.schema);
					map.flow = true;
					map.items.push(pair);
					const endRange = (valueNode ?? keyNode).range;
					map.range = [
						keyNode.range[0],
						endRange[1],
						endRange[2]
					];
					coll.items.push(map);
				}
				offset = valueNode ? valueNode.range[2] : valueProps.end;
			}
		}
		const expectedEnd = isMap ? "}" : "]";
		const [ce, ...ee] = fc.end;
		let cePos = offset;
		if (ce?.source === expectedEnd) cePos = ce.offset + ce.source.length;
		else {
			const name = fcName[0].toUpperCase() + fcName.substring(1);
			const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
			onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
			if (ce && ce.source.length !== 1) ee.unshift(ce);
		}
		if (ee.length > 0) {
			const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
			if (end.comment) {
				if (coll.comment) coll.comment += "\n" + end.comment;
				else coll.comment = end.comment;
			}
			coll.range = [
				fc.offset,
				cePos,
				end.offset
			];
		} else coll.range = [
			fc.offset,
			cePos,
			cePos
		];
		return coll;
	}
	exports.resolveFlowCollection = resolveFlowCollection;
}));

// node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Scalar = require_Scalar();
	var YAMLMap = require_YAMLMap();
	var YAMLSeq = require_YAMLSeq();
	var resolveBlockMap = require_resolve_block_map();
	var resolveBlockSeq = require_resolve_block_seq();
	var resolveFlowCollection = require_resolve_flow_collection();
	function resolveCollection(CN, ctx, token, onError, tagName, tag) {
		const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
		const Coll = coll.constructor;
		if (tagName === "!" || tagName === Coll.tagName) {
			coll.tag = Coll.tagName;
			return coll;
		}
		if (tagName) coll.tag = tagName;
		return coll;
	}
	function composeCollection(CN, ctx, token, props, onError) {
		const tagToken = props.tag;
		const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
		if (token.type === "block-seq") {
			const { anchor, newlineAfterProp: nl } = props;
			const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
			if (lastProp && (!nl || nl.offset < lastProp.offset)) onError(lastProp, "MISSING_CHAR", "Missing newline after block sequence props");
		}
		const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
		if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") return resolveCollection(CN, ctx, token, onError, tagName);
		let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
		if (!tag) {
			const kt = ctx.schema.knownTags[tagName];
			if (kt?.collection === expType) {
				ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
				tag = kt;
			} else {
				if (kt) onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
				else onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
				return resolveCollection(CN, ctx, token, onError, tagName);
			}
		}
		const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
		const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
		const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
		node.range = coll.range;
		node.tag = tagName;
		if (tag?.format) node.format = tag.format;
		return node;
	}
	exports.composeCollection = composeCollection;
}));

// node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	function resolveBlockScalar(ctx, scalar, onError) {
		const start = scalar.offset;
		const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
		if (!header) return {
			value: "",
			type: null,
			comment: "",
			range: [
				start,
				start,
				start
			]
		};
		const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
		const lines = scalar.source ? splitLines(scalar.source) : [];
		let chompStart = lines.length;
		for (let i = lines.length - 1; i >= 0; --i) {
			const content = lines[i][1];
			if (content === "" || content === "\r") chompStart = i;
			else break;
		}
		if (chompStart === 0) {
			const value = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
			let end = start + header.length;
			if (scalar.source) end += scalar.source.length;
			return {
				value,
				type,
				comment: header.comment,
				range: [
					start,
					end,
					end
				]
			};
		}
		let trimIndent = scalar.indent + header.indent;
		let offset = scalar.offset + header.length;
		let contentStart = 0;
		for (let i = 0; i < chompStart; ++i) {
			const [indent, content] = lines[i];
			if (content === "" || content === "\r") {
				if (header.indent === 0 && indent.length > trimIndent) trimIndent = indent.length;
			} else {
				if (indent.length < trimIndent) onError(offset + indent.length, "MISSING_CHAR", "Block scalars with more-indented leading empty lines must use an explicit indentation indicator");
				if (header.indent === 0) trimIndent = indent.length;
				contentStart = i;
				if (trimIndent === 0 && !ctx.atRoot) onError(offset, "BAD_INDENT", "Block scalar values in collections must be indented");
				break;
			}
			offset += indent.length + content.length + 1;
		}
		for (let i = lines.length - 1; i >= chompStart; --i) if (lines[i][0].length > trimIndent) chompStart = i + 1;
		let value = "";
		let sep = "";
		let prevMoreIndented = false;
		for (let i = 0; i < contentStart; ++i) value += lines[i][0].slice(trimIndent) + "\n";
		for (let i = contentStart; i < chompStart; ++i) {
			let [indent, content] = lines[i];
			offset += indent.length + content.length + 1;
			const crlf = content[content.length - 1] === "\r";
			if (crlf) content = content.slice(0, -1);
			/* istanbul ignore if already caught in lexer */
			if (content && indent.length < trimIndent) {
				const message = `Block scalar lines must not be less indented than their ${header.indent ? "explicit indentation indicator" : "first line"}`;
				onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
				indent = "";
			}
			if (type === Scalar.Scalar.BLOCK_LITERAL) {
				value += sep + indent.slice(trimIndent) + content;
				sep = "\n";
			} else if (indent.length > trimIndent || content[0] === "	") {
				if (sep === " ") sep = "\n";
				else if (!prevMoreIndented && sep === "\n") sep = "\n\n";
				value += sep + indent.slice(trimIndent) + content;
				sep = "\n";
				prevMoreIndented = true;
			} else if (content === "") {
				if (sep === "\n") value += "\n";
				else sep = "\n";
			} else {
				value += sep + content;
				sep = " ";
				prevMoreIndented = false;
			}
		}
		switch (header.chomp) {
			case "-": break;
			case "+":
				for (let i = chompStart; i < lines.length; ++i) value += "\n" + lines[i][0].slice(trimIndent);
				if (value[value.length - 1] !== "\n") value += "\n";
				break;
			default: value += "\n";
		}
		const end = start + header.length + scalar.source.length;
		return {
			value,
			type,
			comment: header.comment,
			range: [
				start,
				end,
				end
			]
		};
	}
	function parseBlockScalarHeader({ offset, props }, strict, onError) {
		/* istanbul ignore if should not happen */
		if (props[0].type !== "block-scalar-header") {
			onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
			return null;
		}
		const { source } = props[0];
		const mode = source[0];
		let indent = 0;
		let chomp = "";
		let error = -1;
		for (let i = 1; i < source.length; ++i) {
			const ch = source[i];
			if (!chomp && (ch === "-" || ch === "+")) chomp = ch;
			else {
				const n = Number(ch);
				if (!indent && n) indent = n;
				else if (error === -1) error = offset + i;
			}
		}
		if (error !== -1) onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
		let hasSpace = false;
		let comment = "";
		let length = source.length;
		for (let i = 1; i < props.length; ++i) {
			const token = props[i];
			switch (token.type) {
				case "space": hasSpace = true;
				case "newline":
					length += token.source.length;
					break;
				case "comment":
					if (strict && !hasSpace) onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
					length += token.source.length;
					comment = token.source.substring(1);
					break;
				case "error":
					onError(token, "UNEXPECTED_TOKEN", token.message);
					length += token.source.length;
					break;
				/* istanbul ignore next should not happen */
				default: {
					onError(token, "UNEXPECTED_TOKEN", `Unexpected token in block scalar header: ${token.type}`);
					const ts = token.source;
					if (ts && typeof ts === "string") length += ts.length;
				}
			}
		}
		return {
			mode,
			indent,
			chomp,
			comment,
			length
		};
	}
	/** @returns Array of lines split up as `[indent, content]` */
	function splitLines(source) {
		const split = source.split(/\n( *)/);
		const first = split[0];
		const m = first.match(/^( *)/);
		const lines = [m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first]];
		for (let i = 1; i < split.length; i += 2) lines.push([split[i], split[i + 1]]);
		return lines;
	}
	exports.resolveBlockScalar = resolveBlockScalar;
}));

// node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	var resolveEnd = require_resolve_end();
	function resolveFlowScalar(scalar, strict, onError) {
		const { offset, type, source, end } = scalar;
		let _type;
		let value;
		const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
		switch (type) {
			case "scalar":
				_type = Scalar.Scalar.PLAIN;
				value = plainValue(source, _onError);
				break;
			case "single-quoted-scalar":
				_type = Scalar.Scalar.QUOTE_SINGLE;
				value = singleQuotedValue(source, _onError);
				break;
			case "double-quoted-scalar":
				_type = Scalar.Scalar.QUOTE_DOUBLE;
				value = doubleQuotedValue(source, _onError);
				break;
			/* istanbul ignore next should not happen */
			default:
				onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
				return {
					value: "",
					type: null,
					comment: "",
					range: [
						offset,
						offset + source.length,
						offset + source.length
					]
				};
		}
		const valueEnd = offset + source.length;
		const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
		return {
			value,
			type: _type,
			comment: re.comment,
			range: [
				offset,
				valueEnd,
				re.offset
			]
		};
	}
	function plainValue(source, onError) {
		let badChar = "";
		switch (source[0]) {
			/* istanbul ignore next should not happen */
			case "	":
				badChar = "a tab character";
				break;
			case ",":
				badChar = "flow indicator character ,";
				break;
			case "%":
				badChar = "directive indicator character %";
				break;
			case "|":
			case ">":
				badChar = `block scalar indicator ${source[0]}`;
				break;
			case "@":
			case "`": badChar = `reserved character ${source[0]}`;
		}
		if (badChar) onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
		return unfoldLines(source);
	}
	function singleQuotedValue(source, onError) {
		if (source[source.length - 1] !== "'" || source.length === 1) onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
		return unfoldLines(source.slice(1, -1)).replace(/''/g, "'");
	}
	function unfoldLines(source) {
		const line = /(.*?)\r?\n/sy;
		let match = line.exec(source);
		if (!match) return source;
		/**
		* The negative lookbehinds in these RegExps are to
		* prevent causing a polynomial search time in certain cases.
		*
		* The try-catch is for Safari < 16.4 and other old browsers:
		* https://caniuse.com/js-regexp-lookbehind
		*/
		let trimEnd, trimBoth;
		try {
			trimEnd = /* @__PURE__ */ new RegExp("(?<![ 	])[ 	]+$");
			trimBoth = /* @__PURE__ */ new RegExp("^[ 	]+|(?<![ 	])[ 	]+$", "g");
		} catch {
			trimEnd = /[ \t]+$/;
			trimBoth = /^[ \t]+|[ \t]+$/g;
		}
		let res = match[1].replace(trimEnd, "");
		let sep = " ";
		let pos = line.lastIndex;
		while (match = line.exec(source)) {
			const lm = match[1].replace(trimBoth, "");
			if (lm === "") {
				if (sep === "\n") res += sep;
				else sep = "\n";
			} else {
				res += sep + lm;
				sep = " ";
			}
			pos = line.lastIndex;
		}
		const last = /[ \t]*(.*)/sy;
		last.lastIndex = pos;
		match = last.exec(source);
		return res + sep + (match?.[1] ?? "");
	}
	function doubleQuotedValue(source, onError) {
		let res = "";
		for (let i = 1; i < source.length - 1; ++i) {
			const ch = source[i];
			if (ch === "\r" && source[i + 1] === "\n") continue;
			if (ch === "\n") {
				const { fold, offset } = foldNewline(source, i);
				res += fold;
				i = offset;
			} else if (ch === "\\") {
				let next = source[++i];
				const cc = escapeCodes[next];
				if (cc) res += cc;
				else if (next === "\n") {
					next = source[i + 1];
					while (next === " " || next === "	") next = source[++i + 1];
				} else if (next === "\r" && source[i + 1] === "\n") {
					next = source[++i + 1];
					while (next === " " || next === "	") next = source[++i + 1];
				} else if (next === "x" || next === "u" || next === "U") {
					const length = next === "x" ? 2 : next === "u" ? 4 : 8;
					res += parseCharCode(source, i + 1, length, onError);
					i += length;
				} else {
					const raw = source.substr(i - 1, 2);
					onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
					res += raw;
				}
			} else if (ch === " " || ch === "	") {
				const wsStart = i;
				let next = source[i + 1];
				while (next === " " || next === "	") next = source[++i + 1];
				if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n")) res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
			} else res += ch;
		}
		if (source[source.length - 1] !== "\"" || source.length === 1) onError(source.length, "MISSING_CHAR", "Missing closing \"quote");
		return res;
	}
	/**
	* Fold a single newline into a space, multiple newlines to N - 1 newlines.
	* Presumes `source[offset] === '\n'`
	*/
	function foldNewline(source, offset) {
		let fold = "";
		let ch = source[offset + 1];
		while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
			if (ch === "\r" && source[offset + 2] !== "\n") break;
			if (ch === "\n") fold += "\n";
			offset += 1;
			ch = source[offset + 1];
		}
		if (!fold) fold = " ";
		return {
			fold,
			offset
		};
	}
	const escapeCodes = {
		"0": "\0",
		a: "\x07",
		b: "\b",
		e: "\x1B",
		f: "\f",
		n: "\n",
		r: "\r",
		t: "	",
		v: "\v",
		N: "",
		_: "\xA0",
		L: "\u2028",
		P: "\u2029",
		" ": " ",
		"\"": "\"",
		"/": "/",
		"\\": "\\",
		"	": "	"
	};
	function parseCharCode(source, offset, length, onError) {
		const cc = source.substr(offset, length);
		const code = cc.length === length && /^[0-9a-fA-F]+$/.test(cc) ? parseInt(cc, 16) : NaN;
		try {
			return String.fromCodePoint(code);
		} catch {
			const raw = source.substr(offset - 2, length + 2);
			onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
			return raw;
		}
	}
	exports.resolveFlowScalar = resolveFlowScalar;
}));

// node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Scalar = require_Scalar();
	var resolveBlockScalar = require_resolve_block_scalar();
	var resolveFlowScalar = require_resolve_flow_scalar();
	function composeScalar(ctx, token, tagToken, onError) {
		const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
		const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
		let tag;
		if (ctx.options.stringKeys && ctx.atKey) tag = ctx.schema[identity.SCALAR];
		else if (tagName) tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
		else if (token.type === "scalar") tag = findScalarTagByTest(ctx, value, token, onError);
		else tag = ctx.schema[identity.SCALAR];
		let scalar;
		try {
			const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
			scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
			scalar = new Scalar.Scalar(value);
		}
		scalar.range = range;
		scalar.source = value;
		if (type) scalar.type = type;
		if (tagName) scalar.tag = tagName;
		if (tag.format) scalar.format = tag.format;
		if (comment) scalar.comment = comment;
		return scalar;
	}
	function findScalarTagByName(schema, value, tagName, tagToken, onError) {
		if (tagName === "!") return schema[identity.SCALAR];
		const matchWithTest = [];
		for (const tag of schema.tags) if (!tag.collection && tag.tag === tagName) {
			if (tag.default && tag.test) matchWithTest.push(tag);
			else return tag;
		}
		for (const tag of matchWithTest) if (tag.test?.test(value)) return tag;
		const kt = schema.knownTags[tagName];
		if (kt && !kt.collection) {
			schema.tags.push(Object.assign({}, kt, {
				default: false,
				test: void 0
			}));
			return kt;
		}
		onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
		return schema[identity.SCALAR];
	}
	function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
		const tag = schema.tags.find((tag) => (tag.default === true || atKey && tag.default === "key") && tag.test?.test(value)) || schema[identity.SCALAR];
		if (schema.compat) {
			const compat = schema.compat.find((tag) => tag.default && tag.test?.test(value)) ?? schema[identity.SCALAR];
			if (tag.tag !== compat.tag) onError(token, "TAG_RESOLVE_FAILED", `Value may be parsed as either ${directives.tagString(tag.tag)} or ${directives.tagString(compat.tag)}`, true);
		}
		return tag;
	}
	exports.composeScalar = composeScalar;
}));

// node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = /* @__PURE__ */ __commonJSMin(((exports) => {
	function emptyScalarPosition(offset, before, pos) {
		if (before) {
			pos ?? (pos = before.length);
			for (let i = pos - 1; i >= 0; --i) {
				let st = before[i];
				switch (st.type) {
					case "space":
					case "comment":
					case "newline":
						offset -= st.source.length;
						continue;
				}
				st = before[++i];
				while (st?.type === "space") {
					offset += st.source.length;
					st = before[++i];
				}
				break;
			}
		}
		return offset;
	}
	exports.emptyScalarPosition = emptyScalarPosition;
}));

// node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Alias = require_Alias();
	var identity = require_identity();
	var composeCollection = require_compose_collection();
	var composeScalar = require_compose_scalar();
	var resolveEnd = require_resolve_end();
	var utilEmptyScalarPosition = require_util_empty_scalar_position();
	const CN = {
		composeNode,
		composeEmptyNode
	};
	function composeNode(ctx, token, props, onError) {
		const atKey = ctx.atKey;
		const { spaceBefore, comment, anchor, tag } = props;
		let node;
		let isSrcToken = true;
		switch (token.type) {
			case "alias":
				node = composeAlias(ctx, token, onError);
				if (anchor || tag) onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
				break;
			case "scalar":
			case "single-quoted-scalar":
			case "double-quoted-scalar":
			case "block-scalar":
				node = composeScalar.composeScalar(ctx, token, tag, onError);
				if (anchor) node.anchor = anchor.source.substring(1);
				break;
			case "block-map":
			case "block-seq":
			case "flow-collection":
				try {
					node = composeCollection.composeCollection(CN, ctx, token, props, onError);
					if (anchor) node.anchor = anchor.source.substring(1);
				} catch (error) {
					onError(token, "RESOURCE_EXHAUSTION", error instanceof Error ? error.message : String(error));
				}
				break;
			default:
				onError(token, "UNEXPECTED_TOKEN", token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`);
				isSrcToken = false;
		}
		node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
		if (anchor && node.anchor === "") onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
		if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) onError(tag ?? token, "NON_STRING_KEY", "With stringKeys, all keys must be strings");
		if (spaceBefore) node.spaceBefore = true;
		if (comment) {
			if (token.type === "scalar" && token.source === "") node.comment = comment;
			else node.commentBefore = comment;
		}
		if (ctx.options.keepSourceTokens && isSrcToken) node.srcToken = token;
		return node;
	}
	function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
		const token = {
			type: "scalar",
			offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
			indent: -1,
			source: ""
		};
		const node = composeScalar.composeScalar(ctx, token, tag, onError);
		if (anchor) {
			node.anchor = anchor.source.substring(1);
			if (node.anchor === "") onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
		}
		if (spaceBefore) node.spaceBefore = true;
		if (comment) {
			node.comment = comment;
			node.range[2] = end;
		}
		return node;
	}
	function composeAlias({ options }, { offset, source, end }, onError) {
		const alias = new Alias.Alias(source.substring(1));
		if (alias.source === "") onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
		if (alias.source.endsWith(":")) onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
		const valueEnd = offset + source.length;
		const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
		alias.range = [
			offset,
			valueEnd,
			re.offset
		];
		if (re.comment) alias.comment = re.comment;
		return alias;
	}
	exports.composeEmptyNode = composeEmptyNode;
	exports.composeNode = composeNode;
}));

// node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Document = require_Document();
	var composeNode = require_compose_node();
	var resolveEnd = require_resolve_end();
	var resolveProps = require_resolve_props();
	function composeDoc(options, directives, { offset, start, value, end }, onError) {
		const opts = Object.assign({ _directives: directives }, options);
		const doc = new Document.Document(void 0, opts);
		const ctx = {
			atKey: false,
			atRoot: true,
			directives: doc.directives,
			options: doc.options,
			schema: doc.schema
		};
		const props = resolveProps.resolveProps(start, {
			indicator: "doc-start",
			next: value ?? end?.[0],
			offset,
			onError,
			parentIndent: 0,
			startOnNewline: true
		});
		if (props.found) {
			doc.directives.docStart = true;
			if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline) onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
		}
		doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
		const contentEnd = doc.contents.range[2];
		const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
		if (re.comment) doc.comment = re.comment;
		doc.range = [
			offset,
			contentEnd,
			re.offset
		];
		return doc;
	}
	exports.composeDoc = composeDoc;
}));

// node_modules/yaml/dist/compose/composer.js
var require_composer = /* @__PURE__ */ __commonJSMin(((exports) => {
	var node_process = __require("process");
	var directives = require_directives();
	var Document = require_Document();
	var errors = require_errors();
	var identity = require_identity();
	var composeDoc = require_compose_doc();
	var resolveEnd = require_resolve_end();
	function getErrorPos(src) {
		if (typeof src === "number") return [src, src + 1];
		if (Array.isArray(src)) return src.length === 2 ? src : [src[0], src[1]];
		const { offset, source } = src;
		return [offset, offset + (typeof source === "string" ? source.length : 1)];
	}
	function parsePrelude(prelude) {
		let comment = "";
		let atComment = false;
		let afterEmptyLine = false;
		for (let i = 0; i < prelude.length; ++i) {
			const source = prelude[i];
			switch (source[0]) {
				case "#":
					comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
					atComment = true;
					afterEmptyLine = false;
					break;
				case "%":
					if (prelude[i + 1]?.[0] !== "#") i += 1;
					atComment = false;
					break;
				default:
					if (!atComment) afterEmptyLine = true;
					atComment = false;
			}
		}
		return {
			comment,
			afterEmptyLine
		};
	}
	/**
	* Compose a stream of CST nodes into a stream of YAML Documents.
	*
	* ```ts
	* import { Composer, Parser } from 'yaml'
	*
	* const src: string = ...
	* const tokens = new Parser().parse(src)
	* const docs = new Composer().compose(tokens)
	* ```
	*/
	var Composer = class {
		constructor(options = {}) {
			this.doc = null;
			this.atDirectives = false;
			this.prelude = [];
			this.errors = [];
			this.warnings = [];
			this.onError = (source, code, message, warning) => {
				const pos = getErrorPos(source);
				if (warning) this.warnings.push(new errors.YAMLWarning(pos, code, message));
				else this.errors.push(new errors.YAMLParseError(pos, code, message));
			};
			this.directives = new directives.Directives({ version: options.version || "1.2" });
			this.options = options;
		}
		decorate(doc, afterDoc) {
			const { comment, afterEmptyLine } = parsePrelude(this.prelude);
			if (comment) {
				const dc = doc.contents;
				if (afterDoc) doc.comment = doc.comment ? `${doc.comment}\n${comment}` : comment;
				else if (afterEmptyLine || doc.directives.docStart || !dc) doc.commentBefore = comment;
				else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
					let it = dc.items[0];
					if (identity.isPair(it)) it = it.key;
					const cb = it.commentBefore;
					it.commentBefore = cb ? `${comment}\n${cb}` : comment;
				} else {
					const cb = dc.commentBefore;
					dc.commentBefore = cb ? `${comment}\n${cb}` : comment;
				}
			}
			if (afterDoc) {
				for (let i = 0; i < this.errors.length; ++i) doc.errors.push(this.errors[i]);
				for (let i = 0; i < this.warnings.length; ++i) doc.warnings.push(this.warnings[i]);
			} else {
				doc.errors = this.errors;
				doc.warnings = this.warnings;
			}
			this.prelude = [];
			this.errors = [];
			this.warnings = [];
		}
		/**
		* Current stream status information.
		*
		* Mostly useful at the end of input for an empty stream.
		*/
		streamInfo() {
			return {
				comment: parsePrelude(this.prelude).comment,
				directives: this.directives,
				errors: this.errors,
				warnings: this.warnings
			};
		}
		/**
		* Compose tokens into documents.
		*
		* @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
		* @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
		*/
		*compose(tokens, forceDoc = false, endOffset = -1) {
			for (const token of tokens) yield* this.next(token);
			yield* this.end(forceDoc, endOffset);
		}
		/** Advance the composer by one CST token. */
		*next(token) {
			if (node_process.env.LOG_STREAM) console.dir(token, { depth: null });
			switch (token.type) {
				case "directive":
					this.directives.add(token.source, (offset, message, warning) => {
						const pos = getErrorPos(token);
						pos[0] += offset;
						this.onError(pos, "BAD_DIRECTIVE", message, warning);
					});
					this.prelude.push(token.source);
					this.atDirectives = true;
					break;
				case "document": {
					const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
					if (this.atDirectives && !doc.directives.docStart) this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
					this.decorate(doc, false);
					if (this.doc) yield this.doc;
					this.doc = doc;
					this.atDirectives = false;
					break;
				}
				case "byte-order-mark":
				case "space": break;
				case "comment":
				case "newline":
					this.prelude.push(token.source);
					break;
				case "error": {
					const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
					const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
					if (this.atDirectives || !this.doc) this.errors.push(error);
					else this.doc.errors.push(error);
					break;
				}
				case "doc-end": {
					if (!this.doc) {
						this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", "Unexpected doc-end without preceding document"));
						break;
					}
					this.doc.directives.docEnd = true;
					const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
					this.decorate(this.doc, true);
					if (end.comment) {
						const dc = this.doc.comment;
						this.doc.comment = dc ? `${dc}\n${end.comment}` : end.comment;
					}
					this.doc.range[2] = end.offset;
					break;
				}
				default: this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
			}
		}
		/**
		* Call at end of input to yield any remaining document.
		*
		* @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
		* @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
		*/
		*end(forceDoc = false, endOffset = -1) {
			if (this.doc) {
				this.decorate(this.doc, true);
				yield this.doc;
				this.doc = null;
			} else if (forceDoc) {
				const opts = Object.assign({ _directives: this.directives }, this.options);
				const doc = new Document.Document(void 0, opts);
				if (this.atDirectives) this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
				doc.range = [
					0,
					endOffset,
					endOffset
				];
				this.decorate(doc, false);
				yield doc;
			}
		}
	};
	exports.Composer = Composer;
}));

// node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = /* @__PURE__ */ __commonJSMin(((exports) => {
	var resolveBlockScalar = require_resolve_block_scalar();
	var resolveFlowScalar = require_resolve_flow_scalar();
	var errors = require_errors();
	var stringifyString = require_stringifyString();
	function resolveAsScalar(token, strict = true, onError) {
		if (token) {
			const _onError = (pos, code, message) => {
				const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
				if (onError) onError(offset, code, message);
				else throw new errors.YAMLParseError([offset, offset + 1], code, message);
			};
			switch (token.type) {
				case "scalar":
				case "single-quoted-scalar":
				case "double-quoted-scalar": return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
				case "block-scalar": return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
			}
		}
		return null;
	}
	/**
	* Create a new scalar token with `value`
	*
	* Values that represent an actual string but may be parsed as a different type should use a `type` other than `'PLAIN'`,
	* as this function does not support any schema operations and won't check for such conflicts.
	*
	* @param value The string representation of the value, which will have its content properly indented.
	* @param context.end Comments and whitespace after the end of the value, or after the block scalar header. If undefined, a newline will be added.
	* @param context.implicitKey Being within an implicit key may affect the resolved type of the token's value.
	* @param context.indent The indent level of the token.
	* @param context.inFlow Is this scalar within a flow collection? This may affect the resolved type of the token's value.
	* @param context.offset The offset position of the token.
	* @param context.type The preferred type of the scalar token. If undefined, the previous type of the `token` will be used, defaulting to `'PLAIN'`.
	*/
	function createScalarToken(value, context) {
		const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
		const source = stringifyString.stringifyString({
			type,
			value
		}, {
			implicitKey,
			indent: indent > 0 ? " ".repeat(indent) : "",
			inFlow,
			options: {
				blockQuote: true,
				lineWidth: -1
			}
		});
		const end = context.end ?? [{
			type: "newline",
			offset: -1,
			indent,
			source: "\n"
		}];
		switch (source[0]) {
			case "|":
			case ">": {
				const he = source.indexOf("\n");
				const head = source.substring(0, he);
				const body = source.substring(he + 1) + "\n";
				const props = [{
					type: "block-scalar-header",
					offset,
					indent,
					source: head
				}];
				if (!addEndtoBlockProps(props, end)) props.push({
					type: "newline",
					offset: -1,
					indent,
					source: "\n"
				});
				return {
					type: "block-scalar",
					offset,
					indent,
					props,
					source: body
				};
			}
			case "\"": return {
				type: "double-quoted-scalar",
				offset,
				indent,
				source,
				end
			};
			case "'": return {
				type: "single-quoted-scalar",
				offset,
				indent,
				source,
				end
			};
			default: return {
				type: "scalar",
				offset,
				indent,
				source,
				end
			};
		}
	}
	/**
	* Set the value of `token` to the given string `value`, overwriting any previous contents and type that it may have.
	*
	* Best efforts are made to retain any comments previously associated with the `token`,
	* though all contents within a collection's `items` will be overwritten.
	*
	* Values that represent an actual string but may be parsed as a different type should use a `type` other than `'PLAIN'`,
	* as this function does not support any schema operations and won't check for such conflicts.
	*
	* @param token Any token. If it does not include an `indent` value, the value will be stringified as if it were an implicit key.
	* @param value The string representation of the value, which will have its content properly indented.
	* @param context.afterKey In most cases, values after a key should have an additional level of indentation.
	* @param context.implicitKey Being within an implicit key may affect the resolved type of the token's value.
	* @param context.inFlow Being within a flow collection may affect the resolved type of the token's value.
	* @param context.type The preferred type of the scalar token. If undefined, the previous type of the `token` will be used, defaulting to `'PLAIN'`.
	*/
	function setScalarValue(token, value, context = {}) {
		let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
		let indent = "indent" in token ? token.indent : null;
		if (afterKey && typeof indent === "number") indent += 2;
		if (!type) switch (token.type) {
			case "single-quoted-scalar":
				type = "QUOTE_SINGLE";
				break;
			case "double-quoted-scalar":
				type = "QUOTE_DOUBLE";
				break;
			case "block-scalar": {
				const header = token.props[0];
				if (header.type !== "block-scalar-header") throw new Error("Invalid block scalar header");
				type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
				break;
			}
			default: type = "PLAIN";
		}
		const source = stringifyString.stringifyString({
			type,
			value
		}, {
			implicitKey: implicitKey || indent === null,
			indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
			inFlow,
			options: {
				blockQuote: true,
				lineWidth: -1
			}
		});
		switch (source[0]) {
			case "|":
			case ">":
				setBlockScalarValue(token, source);
				break;
			case "\"":
				setFlowScalarValue(token, source, "double-quoted-scalar");
				break;
			case "'":
				setFlowScalarValue(token, source, "single-quoted-scalar");
				break;
			default: setFlowScalarValue(token, source, "scalar");
		}
	}
	function setBlockScalarValue(token, source) {
		const he = source.indexOf("\n");
		const head = source.substring(0, he);
		const body = source.substring(he + 1) + "\n";
		if (token.type === "block-scalar") {
			const header = token.props[0];
			if (header.type !== "block-scalar-header") throw new Error("Invalid block scalar header");
			header.source = head;
			token.source = body;
		} else {
			const { offset } = token;
			const indent = "indent" in token ? token.indent : -1;
			const props = [{
				type: "block-scalar-header",
				offset,
				indent,
				source: head
			}];
			if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0)) props.push({
				type: "newline",
				offset: -1,
				indent,
				source: "\n"
			});
			for (const key of Object.keys(token)) if (key !== "type" && key !== "offset") delete token[key];
			Object.assign(token, {
				type: "block-scalar",
				indent,
				props,
				source: body
			});
		}
	}
	/** @returns `true` if last token is a newline */
	function addEndtoBlockProps(props, end) {
		if (end) for (const st of end) switch (st.type) {
			case "space":
			case "comment":
				props.push(st);
				break;
			case "newline":
				props.push(st);
				return true;
		}
		return false;
	}
	function setFlowScalarValue(token, source, type) {
		switch (token.type) {
			case "scalar":
			case "double-quoted-scalar":
			case "single-quoted-scalar":
				token.type = type;
				token.source = source;
				break;
			case "block-scalar": {
				const end = token.props.slice(1);
				let oa = source.length;
				if (token.props[0].type === "block-scalar-header") oa -= token.props[0].source.length;
				for (const tok of end) tok.offset += oa;
				delete token.props;
				Object.assign(token, {
					type,
					source,
					end
				});
				break;
			}
			case "block-map":
			case "block-seq": {
				const nl = {
					type: "newline",
					offset: token.offset + source.length,
					indent: token.indent,
					source: "\n"
				};
				delete token.items;
				Object.assign(token, {
					type,
					source,
					end: [nl]
				});
				break;
			}
			default: {
				const indent = "indent" in token ? token.indent : -1;
				const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
				for (const key of Object.keys(token)) if (key !== "type" && key !== "offset") delete token[key];
				Object.assign(token, {
					type,
					indent,
					source,
					end
				});
			}
		}
	}
	exports.createScalarToken = createScalarToken;
	exports.resolveAsScalar = resolveAsScalar;
	exports.setScalarValue = setScalarValue;
}));

// node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Stringify a CST document, token, or collection item
	*
	* Fair warning: This applies no validation whatsoever, and
	* simply concatenates the sources in their logical order.
	*/
	const stringify = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
	function stringifyToken(token) {
		switch (token.type) {
			case "block-scalar": {
				let res = "";
				for (const tok of token.props) res += stringifyToken(tok);
				return res + token.source;
			}
			case "block-map":
			case "block-seq": {
				let res = "";
				for (const item of token.items) res += stringifyItem(item);
				return res;
			}
			case "flow-collection": {
				let res = token.start.source;
				for (const item of token.items) res += stringifyItem(item);
				for (const st of token.end) res += st.source;
				return res;
			}
			case "document": {
				let res = stringifyItem(token);
				if (token.end) for (const st of token.end) res += st.source;
				return res;
			}
			default: {
				let res = token.source;
				if ("end" in token && token.end) for (const st of token.end) res += st.source;
				return res;
			}
		}
	}
	function stringifyItem({ start, key, sep, value }) {
		let res = "";
		for (const st of start) res += st.source;
		if (key) res += stringifyToken(key);
		if (sep) for (const st of sep) res += st.source;
		if (value) res += stringifyToken(value);
		return res;
	}
	exports.stringify = stringify;
}));

// node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = /* @__PURE__ */ __commonJSMin(((exports) => {
	const BREAK = Symbol("break visit");
	const SKIP = Symbol("skip children");
	const REMOVE = Symbol("remove item");
	/**
	* Apply a visitor to a CST document or item.
	*
	* Walks through the tree (depth-first) starting from the root, calling a
	* `visitor` function with two arguments when entering each item:
	*   - `item`: The current item, which included the following members:
	*     - `start: SourceToken[]` – Source tokens before the key or value,
	*       possibly including its anchor or tag.
	*     - `key?: Token | null` – Set for pair values. May then be `null`, if
	*       the key before the `:` separator is empty.
	*     - `sep?: SourceToken[]` – Source tokens between the key and the value,
	*       which should include the `:` map value indicator if `value` is set.
	*     - `value?: Token` – The value of a sequence item, or of a map pair.
	*   - `path`: The steps from the root to the current node, as an array of
	*     `['key' | 'value', number]` tuples.
	*
	* The return value of the visitor may be used to control the traversal:
	*   - `undefined` (default): Do nothing and continue
	*   - `visit.SKIP`: Do not visit the children of this token, continue with
	*      next sibling
	*   - `visit.BREAK`: Terminate traversal completely
	*   - `visit.REMOVE`: Remove the current item, then continue with the next one
	*   - `number`: Set the index of the next step. This is useful especially if
	*     the index of the current token has changed.
	*   - `function`: Define the next visitor for this item. After the original
	*     visitor is called on item entry, next visitors are called after handling
	*     a non-empty `key` and when exiting the item.
	*/
	function visit(cst, visitor) {
		if ("type" in cst && cst.type === "document") cst = {
			start: cst.start,
			value: cst.value
		};
		_visit(Object.freeze([]), cst, visitor);
	}
	/** Terminate visit traversal completely */
	visit.BREAK = BREAK;
	/** Do not visit the children of the current item */
	visit.SKIP = SKIP;
	/** Remove the current item */
	visit.REMOVE = REMOVE;
	/** Find the item at `path` from `cst` as the root */
	visit.itemAtPath = (cst, path) => {
		let item = cst;
		for (const [field, index] of path) {
			const tok = item?.[field];
			if (tok && "items" in tok) item = tok.items[index];
			else return void 0;
		}
		return item;
	};
	/**
	* Get the immediate parent collection of the item at `path` from `cst` as the root.
	*
	* Throws an error if the collection is not found, which should never happen if the item itself exists.
	*/
	visit.parentCollection = (cst, path) => {
		const parent = visit.itemAtPath(cst, path.slice(0, -1));
		const field = path[path.length - 1][0];
		const coll = parent?.[field];
		if (coll && "items" in coll) return coll;
		throw new Error("Parent collection not found");
	};
	function _visit(path, item, visitor) {
		let ctrl = visitor(item, path);
		if (typeof ctrl === "symbol") return ctrl;
		for (const field of ["key", "value"]) {
			const token = item[field];
			if (token && "items" in token) {
				for (let i = 0; i < token.items.length; ++i) {
					const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
					if (typeof ci === "number") i = ci - 1;
					else if (ci === BREAK) return BREAK;
					else if (ci === REMOVE) {
						token.items.splice(i, 1);
						i -= 1;
					}
				}
				if (typeof ctrl === "function" && field === "key") ctrl = ctrl(item, path);
			}
		}
		return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
	}
	exports.visit = visit;
}));

// node_modules/yaml/dist/parse/cst.js
var require_cst = /* @__PURE__ */ __commonJSMin(((exports) => {
	var cstScalar = require_cst_scalar();
	var cstStringify = require_cst_stringify();
	var cstVisit = require_cst_visit();
	/** The byte order mark */
	const BOM = "﻿";
	/** Start of doc-mode */
	const DOCUMENT = "";
	/** Unexpected end of flow-mode */
	const FLOW_END = "";
	/** Next token is a scalar value */
	const SCALAR = "";
	/** @returns `true` if `token` is a flow or block collection */
	const isCollection = (token) => !!token && "items" in token;
	/** @returns `true` if `token` is a flow or block scalar; not an alias */
	const isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
	/* istanbul ignore next */
	/** Get a printable representation of a lexer token */
	function prettyToken(token) {
		switch (token) {
			case BOM: return "<BOM>";
			case DOCUMENT: return "<DOC>";
			case FLOW_END: return "<FLOW_END>";
			case SCALAR: return "<SCALAR>";
			default: return JSON.stringify(token);
		}
	}
	/** Identify the type of a lexer token. May return `null` for unknown tokens. */
	function tokenType(source) {
		switch (source) {
			case BOM: return "byte-order-mark";
			case DOCUMENT: return "doc-mode";
			case FLOW_END: return "flow-error-end";
			case SCALAR: return "scalar";
			case "---": return "doc-start";
			case "...": return "doc-end";
			case "":
			case "\n":
			case "\r\n": return "newline";
			case "-": return "seq-item-ind";
			case "?": return "explicit-key-ind";
			case ":": return "map-value-ind";
			case "{": return "flow-map-start";
			case "}": return "flow-map-end";
			case "[": return "flow-seq-start";
			case "]": return "flow-seq-end";
			case ",": return "comma";
		}
		switch (source[0]) {
			case " ":
			case "	": return "space";
			case "#": return "comment";
			case "%": return "directive-line";
			case "*": return "alias";
			case "&": return "anchor";
			case "!": return "tag";
			case "'": return "single-quoted-scalar";
			case "\"": return "double-quoted-scalar";
			case "|":
			case ">": return "block-scalar-header";
		}
		return null;
	}
	exports.createScalarToken = cstScalar.createScalarToken;
	exports.resolveAsScalar = cstScalar.resolveAsScalar;
	exports.setScalarValue = cstScalar.setScalarValue;
	exports.stringify = cstStringify.stringify;
	exports.visit = cstVisit.visit;
	exports.BOM = BOM;
	exports.DOCUMENT = DOCUMENT;
	exports.FLOW_END = FLOW_END;
	exports.SCALAR = SCALAR;
	exports.isCollection = isCollection;
	exports.isScalar = isScalar;
	exports.prettyToken = prettyToken;
	exports.tokenType = tokenType;
}));

// node_modules/yaml/dist/parse/lexer.js
var require_lexer = /* @__PURE__ */ __commonJSMin(((exports) => {
	var cst = require_cst();
	function isEmpty(ch) {
		switch (ch) {
			case void 0:
			case " ":
			case "\n":
			case "\r":
			case "	": return true;
			default: return false;
		}
	}
	const hexDigits = /* @__PURE__ */ new Set("0123456789ABCDEFabcdef");
	const tagChars = /* @__PURE__ */ new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
	const flowIndicatorChars = /* @__PURE__ */ new Set(",[]{}");
	const invalidAnchorChars = /* @__PURE__ */ new Set(" ,[]{}\n\r	");
	const isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
	/**
	* Splits an input string into lexical tokens, i.e. smaller strings that are
	* easily identifiable by `tokens.tokenType()`.
	*
	* Lexing starts always in a "stream" context. Incomplete input may be buffered
	* until a complete token can be emitted.
	*
	* In addition to slices of the original input, the following control characters
	* may also be emitted:
	*
	* - `\x02` (Start of Text): A document starts with the next token
	* - `\x18` (Cancel): Unexpected end of flow-mode (indicates an error)
	* - `\x1f` (Unit Separator): Next token is a scalar value
	* - `\u{FEFF}` (Byte order mark): Emitted separately outside documents
	*/
	var Lexer = class {
		constructor() {
			/**
			* Flag indicating whether the end of the current buffer marks the end of
			* all input
			*/
			this.atEnd = false;
			/**
			* Explicit indent set in block scalar header, as an offset from the current
			* minimum indent, so e.g. set to 1 from a header `|2+`. Set to -1 if not
			* explicitly set.
			*/
			this.blockScalarIndent = -1;
			/**
			* Block scalars that include a + (keep) chomping indicator in their header
			* include trailing empty lines, which are otherwise excluded from the
			* scalar's contents.
			*/
			this.blockScalarKeep = false;
			/** Current input */
			this.buffer = "";
			/**
			* Flag noting whether the map value indicator : can immediately follow this
			* node within a flow context.
			*/
			this.flowKey = false;
			/** Count of surrounding flow collection levels. */
			this.flowLevel = 0;
			/**
			* Minimum level of indentation required for next lines to be parsed as a
			* part of the current scalar value.
			*/
			this.indentNext = 0;
			/** Indentation level of the current line. */
			this.indentValue = 0;
			/** Position of the next \n character. */
			this.lineEndPos = null;
			/** Stores the state of the lexer if reaching the end of incpomplete input */
			this.next = null;
			/** A pointer to `buffer`; the current position of the lexer. */
			this.pos = 0;
		}
		/**
		* Generate YAML tokens from the `source` string. If `incomplete`,
		* a part of the last line may be left as a buffer for the next call.
		*
		* @returns A generator of lexical tokens
		*/
		*lex(source, incomplete = false) {
			if (source) {
				if (typeof source !== "string") throw TypeError("source is not a string");
				this.buffer = this.buffer ? this.buffer + source : source;
				this.lineEndPos = null;
			}
			this.atEnd = !incomplete;
			let next = this.next ?? "stream";
			while (next && (incomplete || this.hasChars(1))) next = yield* this.parseNext(next);
		}
		atLineEnd() {
			let i = this.pos;
			let ch = this.buffer[i];
			while (ch === " " || ch === "	") ch = this.buffer[++i];
			if (!ch || ch === "#" || ch === "\n") return true;
			if (ch === "\r") return this.buffer[i + 1] === "\n";
			return false;
		}
		charAt(n) {
			return this.buffer[this.pos + n];
		}
		continueScalar(offset) {
			let ch = this.buffer[offset];
			if (this.indentNext > 0) {
				let indent = 0;
				while (ch === " ") ch = this.buffer[++indent + offset];
				if (ch === "\r") {
					const next = this.buffer[indent + offset + 1];
					if (next === "\n" || !next && !this.atEnd) return offset + indent + 1;
				}
				return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
			}
			if (ch === "-" || ch === ".") {
				const dt = this.buffer.substr(offset, 3);
				if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3])) return -1;
			}
			return offset;
		}
		getLine() {
			let end = this.lineEndPos;
			if (typeof end !== "number" || end !== -1 && end < this.pos) {
				end = this.buffer.indexOf("\n", this.pos);
				this.lineEndPos = end;
			}
			if (end === -1) return this.atEnd ? this.buffer.substring(this.pos) : null;
			if (this.buffer[end - 1] === "\r") end -= 1;
			return this.buffer.substring(this.pos, end);
		}
		hasChars(n) {
			return this.pos + n <= this.buffer.length;
		}
		setNext(state) {
			this.buffer = this.buffer.substring(this.pos);
			this.pos = 0;
			this.lineEndPos = null;
			this.next = state;
			return null;
		}
		peek(n) {
			return this.buffer.substr(this.pos, n);
		}
		*parseNext(next) {
			switch (next) {
				case "stream": return yield* this.parseStream();
				case "line-start": return yield* this.parseLineStart();
				case "block-start": return yield* this.parseBlockStart();
				case "doc": return yield* this.parseDocument();
				case "flow": return yield* this.parseFlowCollection();
				case "quoted-scalar": return yield* this.parseQuotedScalar();
				case "block-scalar": return yield* this.parseBlockScalar();
				case "plain-scalar": return yield* this.parsePlainScalar();
			}
		}
		*parseStream() {
			let line = this.getLine();
			if (line === null) return this.setNext("stream");
			if (line[0] === cst.BOM) {
				yield* this.pushCount(1);
				line = line.substring(1);
			}
			if (line[0] === "%") {
				let dirEnd = line.length;
				let cs = line.indexOf("#");
				while (cs !== -1) {
					const ch = line[cs - 1];
					if (ch === " " || ch === "	") {
						dirEnd = cs - 1;
						break;
					} else cs = line.indexOf("#", cs + 1);
				}
				while (true) {
					const ch = line[dirEnd - 1];
					if (ch === " " || ch === "	") dirEnd -= 1;
					else break;
				}
				const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
				yield* this.pushCount(line.length - n);
				this.pushNewline();
				return "stream";
			}
			if (this.atLineEnd()) {
				const sp = yield* this.pushSpaces(true);
				yield* this.pushCount(line.length - sp);
				yield* this.pushNewline();
				return "stream";
			}
			yield cst.DOCUMENT;
			return yield* this.parseLineStart();
		}
		*parseLineStart() {
			const ch = this.charAt(0);
			if (!ch && !this.atEnd) return this.setNext("line-start");
			if (ch === "-" || ch === ".") {
				if (!this.atEnd && !this.hasChars(4)) return this.setNext("line-start");
				const s = this.peek(3);
				if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
					yield* this.pushCount(3);
					this.indentValue = 0;
					this.indentNext = 0;
					return s === "---" ? "doc" : "stream";
				}
			}
			this.indentValue = yield* this.pushSpaces(false);
			if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1))) this.indentNext = this.indentValue;
			return yield* this.parseBlockStart();
		}
		*parseBlockStart() {
			const [ch0, ch1] = this.peek(2);
			if (!ch1 && !this.atEnd) return this.setNext("block-start");
			if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
				const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
				this.indentNext = this.indentValue + 1;
				this.indentValue += n;
				return "block-start";
			}
			return "doc";
		}
		*parseDocument() {
			yield* this.pushSpaces(true);
			const line = this.getLine();
			if (line === null) return this.setNext("doc");
			let n = yield* this.pushIndicators();
			switch (line[n]) {
				case "#": yield* this.pushCount(line.length - n);
				case void 0:
					yield* this.pushNewline();
					return yield* this.parseLineStart();
				case "{":
				case "[":
					yield* this.pushCount(1);
					this.flowKey = false;
					this.flowLevel = 1;
					return "flow";
				case "}":
				case "]":
					yield* this.pushCount(1);
					return "doc";
				case "*":
					yield* this.pushUntil(isNotAnchorChar);
					return "doc";
				case "\"":
				case "'": return yield* this.parseQuotedScalar();
				case "|":
				case ">":
					n += yield* this.parseBlockScalarHeader();
					n += yield* this.pushSpaces(true);
					yield* this.pushCount(line.length - n);
					yield* this.pushNewline();
					return yield* this.parseBlockScalar();
				default: return yield* this.parsePlainScalar();
			}
		}
		*parseFlowCollection() {
			let nl, sp;
			let indent = -1;
			do {
				nl = yield* this.pushNewline();
				if (nl > 0) {
					sp = yield* this.pushSpaces(false);
					this.indentValue = indent = sp;
				} else sp = 0;
				sp += yield* this.pushSpaces(true);
			} while (nl + sp > 0);
			const line = this.getLine();
			if (line === null) return this.setNext("flow");
			if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
				if (!(indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}"))) {
					this.flowLevel = 0;
					yield cst.FLOW_END;
					return yield* this.parseLineStart();
				}
			}
			let n = 0;
			while (line[n] === ",") {
				n += yield* this.pushCount(1);
				n += yield* this.pushSpaces(true);
				this.flowKey = false;
			}
			n += yield* this.pushIndicators();
			switch (line[n]) {
				case void 0: return "flow";
				case "#":
					yield* this.pushCount(line.length - n);
					return "flow";
				case "{":
				case "[":
					yield* this.pushCount(1);
					this.flowKey = false;
					this.flowLevel += 1;
					return "flow";
				case "}":
				case "]":
					yield* this.pushCount(1);
					this.flowKey = true;
					this.flowLevel -= 1;
					return this.flowLevel ? "flow" : "doc";
				case "*":
					yield* this.pushUntil(isNotAnchorChar);
					return "flow";
				case "\"":
				case "'":
					this.flowKey = true;
					return yield* this.parseQuotedScalar();
				case ":": {
					const next = this.charAt(1);
					if (this.flowKey || isEmpty(next) || next === ",") {
						this.flowKey = false;
						yield* this.pushCount(1);
						yield* this.pushSpaces(true);
						return "flow";
					}
				}
				default:
					this.flowKey = false;
					return yield* this.parsePlainScalar();
			}
		}
		*parseQuotedScalar() {
			const quote = this.charAt(0);
			let end = this.buffer.indexOf(quote, this.pos + 1);
			if (quote === "'") while (end !== -1 && this.buffer[end + 1] === "'") end = this.buffer.indexOf("'", end + 2);
			else while (end !== -1) {
				let n = 0;
				while (this.buffer[end - 1 - n] === "\\") n += 1;
				if (n % 2 === 0) break;
				end = this.buffer.indexOf("\"", end + 1);
			}
			const qb = this.buffer.substring(0, end);
			let nl = qb.indexOf("\n", this.pos);
			if (nl !== -1) {
				while (nl !== -1) {
					const cs = this.continueScalar(nl + 1);
					if (cs === -1) break;
					nl = qb.indexOf("\n", cs);
				}
				if (nl !== -1) end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
			}
			if (end === -1) {
				if (!this.atEnd) return this.setNext("quoted-scalar");
				end = this.buffer.length;
			}
			yield* this.pushToIndex(end + 1, false);
			return this.flowLevel ? "flow" : "doc";
		}
		*parseBlockScalarHeader() {
			this.blockScalarIndent = -1;
			this.blockScalarKeep = false;
			let i = this.pos;
			while (true) {
				const ch = this.buffer[++i];
				if (ch === "+") this.blockScalarKeep = true;
				else if (ch > "0" && ch <= "9") this.blockScalarIndent = Number(ch) - 1;
				else if (ch !== "-") break;
			}
			return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
		}
		*parseBlockScalar() {
			let nl = this.pos - 1;
			let indent = 0;
			let ch;
			loop: for (let i = this.pos; ch = this.buffer[i]; ++i) switch (ch) {
				case " ":
					indent += 1;
					break;
				case "\n":
					nl = i;
					indent = 0;
					break;
				case "\r": {
					const next = this.buffer[i + 1];
					if (!next && !this.atEnd) return this.setNext("block-scalar");
					if (next === "\n") break;
				}
				default: break loop;
			}
			if (!ch && !this.atEnd) return this.setNext("block-scalar");
			if (indent >= this.indentNext) {
				if (this.blockScalarIndent === -1) this.indentNext = indent;
				else this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
				do {
					const cs = this.continueScalar(nl + 1);
					if (cs === -1) break;
					nl = this.buffer.indexOf("\n", cs);
				} while (nl !== -1);
				if (nl === -1) {
					if (!this.atEnd) return this.setNext("block-scalar");
					nl = this.buffer.length;
				}
			}
			let i = nl + 1;
			ch = this.buffer[i];
			while (ch === " ") ch = this.buffer[++i];
			if (ch === "	") {
				while (ch === "	" || ch === " " || ch === "\r" || ch === "\n") ch = this.buffer[++i];
				nl = i - 1;
			} else if (!this.blockScalarKeep) do {
				let i = nl - 1;
				let ch = this.buffer[i];
				if (ch === "\r") ch = this.buffer[--i];
				const lastChar = i;
				while (ch === " ") ch = this.buffer[--i];
				if (ch === "\n" && i >= this.pos && i + 1 + indent > lastChar) nl = i;
				else break;
			} while (true);
			yield cst.SCALAR;
			yield* this.pushToIndex(nl + 1, true);
			return yield* this.parseLineStart();
		}
		*parsePlainScalar() {
			const inFlow = this.flowLevel > 0;
			let end = this.pos - 1;
			let i = this.pos - 1;
			let ch;
			while (ch = this.buffer[++i]) if (ch === ":") {
				const next = this.buffer[i + 1];
				if (isEmpty(next) || inFlow && flowIndicatorChars.has(next)) break;
				end = i;
			} else if (isEmpty(ch)) {
				let next = this.buffer[i + 1];
				if (ch === "\r") {
					if (next === "\n") {
						i += 1;
						ch = "\n";
						next = this.buffer[i + 1];
					} else end = i;
				}
				if (next === "#" || inFlow && flowIndicatorChars.has(next)) break;
				if (ch === "\n") {
					const cs = this.continueScalar(i + 1);
					if (cs === -1) break;
					i = Math.max(i, cs - 2);
				}
			} else {
				if (inFlow && flowIndicatorChars.has(ch)) break;
				end = i;
			}
			if (!ch && !this.atEnd) return this.setNext("plain-scalar");
			yield cst.SCALAR;
			yield* this.pushToIndex(end + 1, true);
			return inFlow ? "flow" : "doc";
		}
		*pushCount(n) {
			if (n > 0) {
				yield this.buffer.substr(this.pos, n);
				this.pos += n;
				return n;
			}
			return 0;
		}
		*pushToIndex(i, allowEmpty) {
			const s = this.buffer.slice(this.pos, i);
			if (s) {
				yield s;
				this.pos += s.length;
				return s.length;
			} else if (allowEmpty) yield "";
			return 0;
		}
		*pushIndicators() {
			let n = 0;
			loop: while (true) {
				switch (this.charAt(0)) {
					case "!":
						n += yield* this.pushTag();
						n += yield* this.pushSpaces(true);
						continue loop;
					case "&":
						n += yield* this.pushUntil(isNotAnchorChar);
						n += yield* this.pushSpaces(true);
						continue loop;
					case "-":
					case "?":
					case ":": {
						const inFlow = this.flowLevel > 0;
						const ch1 = this.charAt(1);
						if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
							if (!inFlow) this.indentNext = this.indentValue + 1;
							else if (this.flowKey) this.flowKey = false;
							n += yield* this.pushCount(1);
							n += yield* this.pushSpaces(true);
							continue loop;
						}
					}
				}
				break loop;
			}
			return n;
		}
		*pushTag() {
			if (this.charAt(1) === "<") {
				let i = this.pos + 2;
				let ch = this.buffer[i];
				while (!isEmpty(ch) && ch !== ">") ch = this.buffer[++i];
				return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
			} else {
				let i = this.pos + 1;
				let ch = this.buffer[i];
				while (ch) if (tagChars.has(ch)) ch = this.buffer[++i];
				else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) ch = this.buffer[i += 3];
				else break;
				return yield* this.pushToIndex(i, false);
			}
		}
		*pushNewline() {
			const ch = this.buffer[this.pos];
			if (ch === "\n") return yield* this.pushCount(1);
			else if (ch === "\r" && this.charAt(1) === "\n") return yield* this.pushCount(2);
			else return 0;
		}
		*pushSpaces(allowTabs) {
			let i = this.pos - 1;
			let ch;
			do
				ch = this.buffer[++i];
			while (ch === " " || allowTabs && ch === "	");
			const n = i - this.pos;
			if (n > 0) {
				yield this.buffer.substr(this.pos, n);
				this.pos = i;
			}
			return n;
		}
		*pushUntil(test) {
			let i = this.pos;
			let ch = this.buffer[i];
			while (!test(ch)) ch = this.buffer[++i];
			return yield* this.pushToIndex(i, false);
		}
	};
	exports.Lexer = Lexer;
}));

// node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Tracks newlines during parsing in order to provide an efficient API for
	* determining the one-indexed `{ line, col }` position for any offset
	* within the input.
	*/
	var LineCounter = class {
		constructor() {
			this.lineStarts = [];
			/**
			* Should be called in ascending order. Otherwise, call
			* `lineCounter.lineStarts.sort()` before calling `linePos()`.
			*/
			this.addNewLine = (offset) => this.lineStarts.push(offset);
			/**
			* Performs a binary search and returns the 1-indexed { line, col }
			* position of `offset`. If `line === 0`, `addNewLine` has never been
			* called or `offset` is before the first known newline.
			*/
			this.linePos = (offset) => {
				let low = 0;
				let high = this.lineStarts.length;
				while (low < high) {
					const mid = low + high >> 1;
					if (this.lineStarts[mid] < offset) low = mid + 1;
					else high = mid;
				}
				if (this.lineStarts[low] === offset) return {
					line: low + 1,
					col: 1
				};
				if (low === 0) return {
					line: 0,
					col: offset
				};
				const start = this.lineStarts[low - 1];
				return {
					line: low,
					col: offset - start + 1
				};
			};
		}
	};
	exports.LineCounter = LineCounter;
}));

// node_modules/yaml/dist/parse/parser.js
var require_parser = /* @__PURE__ */ __commonJSMin(((exports) => {
	var node_process = __require("process");
	var cst = require_cst();
	var lexer = require_lexer();
	function includesToken(list, type) {
		for (let i = 0; i < list.length; ++i) if (list[i].type === type) return true;
		return false;
	}
	function findNonEmptyIndex(list) {
		for (let i = 0; i < list.length; ++i) switch (list[i].type) {
			case "space":
			case "comment":
			case "newline": break;
			default: return i;
		}
		return -1;
	}
	function isFlowToken(token) {
		switch (token?.type) {
			case "alias":
			case "scalar":
			case "single-quoted-scalar":
			case "double-quoted-scalar":
			case "flow-collection": return true;
			default: return false;
		}
	}
	function getPrevProps(parent) {
		switch (parent.type) {
			case "document": return parent.start;
			case "block-map": {
				const it = parent.items[parent.items.length - 1];
				return it.sep ?? it.start;
			}
			case "block-seq": return parent.items[parent.items.length - 1].start;
			/* istanbul ignore next should not happen */
			default: return [];
		}
	}
	/** Note: May modify input array */
	function getFirstKeyStartProps(prev) {
		if (prev.length === 0) return [];
		let i = prev.length;
		loop: while (--i >= 0) switch (prev[i].type) {
			case "doc-start":
			case "explicit-key-ind":
			case "map-value-ind":
			case "seq-item-ind":
			case "newline": break loop;
		}
		while (prev[++i]?.type === "space");
		return prev.splice(i, prev.length);
	}
	function arrayPushArray(target, source) {
		if (source.length < 1e5) Array.prototype.push.apply(target, source);
		else for (let i = 0; i < source.length; ++i) target.push(source[i]);
	}
	function fixFlowSeqItems(fc) {
		if (fc.start.type === "flow-seq-start") {
			for (const it of fc.items) if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
				if (it.key) it.value = it.key;
				delete it.key;
				if (isFlowToken(it.value)) {
					if (it.value.end) arrayPushArray(it.value.end, it.sep);
					else it.value.end = it.sep;
				} else arrayPushArray(it.start, it.sep);
				delete it.sep;
			}
		}
	}
	/**
	* A YAML concrete syntax tree (CST) parser
	*
	* ```ts
	* const src: string = ...
	* for (const token of new Parser().parse(src)) {
	*   // token: Token
	* }
	* ```
	*
	* To use the parser with a user-provided lexer:
	*
	* ```ts
	* function* parse(source: string, lexer: Lexer) {
	*   const parser = new Parser()
	*   for (const lexeme of lexer.lex(source))
	*     yield* parser.next(lexeme)
	*   yield* parser.end()
	* }
	*
	* const src: string = ...
	* const lexer = new Lexer()
	* for (const token of parse(src, lexer)) {
	*   // token: Token
	* }
	* ```
	*/
	var Parser = class {
		/**
		* @param onNewLine - If defined, called separately with the start position of
		*   each new line (in `parse()`, including the start of input).
		*/
		constructor(onNewLine) {
			/** If true, space and sequence indicators count as indentation */
			this.atNewLine = true;
			/** If true, next token is a scalar value */
			this.atScalar = false;
			/** Current indentation level */
			this.indent = 0;
			/** Current offset since the start of parsing */
			this.offset = 0;
			/** On the same line with a block map key */
			this.onKeyLine = false;
			/** Top indicates the node that's currently being built */
			this.stack = [];
			/** The source of the current token, set in parse() */
			this.source = "";
			/** The type of the current token, set in parse() */
			this.type = "";
			this.lexer = new lexer.Lexer();
			this.onNewLine = onNewLine;
		}
		/**
		* Parse `source` as a YAML stream.
		* If `incomplete`, a part of the last line may be left as a buffer for the next call.
		*
		* Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
		*
		* @returns A generator of tokens representing each directive, document, and other structure.
		*/
		*parse(source, incomplete = false) {
			if (this.onNewLine && this.offset === 0) this.onNewLine(0);
			for (const lexeme of this.lexer.lex(source, incomplete)) yield* this.next(lexeme);
			if (!incomplete) yield* this.end();
		}
		/**
		* Advance the parser by the `source` of one lexical token.
		*/
		*next(source) {
			this.source = source;
			if (node_process.env.LOG_TOKENS) console.log("|", cst.prettyToken(source));
			if (this.atScalar) {
				this.atScalar = false;
				yield* this.step();
				this.offset += source.length;
				return;
			}
			const type = cst.tokenType(source);
			if (!type) {
				const message = `Not a YAML token: ${source}`;
				yield* this.pop({
					type: "error",
					offset: this.offset,
					message,
					source
				});
				this.offset += source.length;
			} else if (type === "scalar") {
				this.atNewLine = false;
				this.atScalar = true;
				this.type = "scalar";
			} else {
				this.type = type;
				yield* this.step();
				switch (type) {
					case "newline":
						this.atNewLine = true;
						this.indent = 0;
						if (this.onNewLine) this.onNewLine(this.offset + source.length);
						break;
					case "space":
						if (this.atNewLine && source[0] === " ") this.indent += source.length;
						break;
					case "explicit-key-ind":
					case "map-value-ind":
					case "seq-item-ind":
						if (this.atNewLine) this.indent += source.length;
						break;
					case "doc-mode":
					case "flow-error-end": return;
					default: this.atNewLine = false;
				}
				this.offset += source.length;
			}
		}
		/** Call at end of input to push out any remaining constructions */
		*end() {
			while (this.stack.length > 0) yield* this.pop();
		}
		get sourceToken() {
			return {
				type: this.type,
				offset: this.offset,
				indent: this.indent,
				source: this.source
			};
		}
		*step() {
			const top = this.peek(1);
			if (this.type === "doc-end" && top?.type !== "doc-end") {
				while (this.stack.length > 0) yield* this.pop();
				this.stack.push({
					type: "doc-end",
					offset: this.offset,
					source: this.source
				});
				return;
			}
			if (!top) return yield* this.stream();
			switch (top.type) {
				case "document": return yield* this.document(top);
				case "alias":
				case "scalar":
				case "single-quoted-scalar":
				case "double-quoted-scalar": return yield* this.scalar(top);
				case "block-scalar": return yield* this.blockScalar(top);
				case "block-map": return yield* this.blockMap(top);
				case "block-seq": return yield* this.blockSequence(top);
				case "flow-collection": return yield* this.flowCollection(top);
				case "doc-end": return yield* this.documentEnd(top);
			}
			/* istanbul ignore next should not happen */
			yield* this.pop();
		}
		peek(n) {
			return this.stack[this.stack.length - n];
		}
		*pop(error) {
			const token = error ?? this.stack.pop();
			/* istanbul ignore if should not happen */
			if (!token) yield {
				type: "error",
				offset: this.offset,
				source: "",
				message: "Tried to pop an empty stack"
			};
			else if (this.stack.length === 0) yield token;
			else {
				const top = this.peek(1);
				if (token.type === "block-scalar") token.indent = "indent" in top ? top.indent : 0;
				else if (token.type === "flow-collection" && top.type === "document") token.indent = 0;
				if (token.type === "flow-collection") fixFlowSeqItems(token);
				switch (top.type) {
					case "document":
						top.value = token;
						break;
					case "block-scalar":
						top.props.push(token);
						break;
					case "block-map": {
						const it = top.items[top.items.length - 1];
						if (it.value) {
							top.items.push({
								start: [],
								key: token,
								sep: []
							});
							this.onKeyLine = true;
							return;
						} else if (it.sep) it.value = token;
						else {
							Object.assign(it, {
								key: token,
								sep: []
							});
							this.onKeyLine = !it.explicitKey;
							return;
						}
						break;
					}
					case "block-seq": {
						const it = top.items[top.items.length - 1];
						if (it.value) top.items.push({
							start: [],
							value: token
						});
						else it.value = token;
						break;
					}
					case "flow-collection": {
						const it = top.items[top.items.length - 1];
						if (!it || it.value) top.items.push({
							start: [],
							key: token,
							sep: []
						});
						else if (it.sep) it.value = token;
						else Object.assign(it, {
							key: token,
							sep: []
						});
						return;
					}
					/* istanbul ignore next should not happen */
					default:
						yield* this.pop();
						yield* this.pop(token);
				}
				if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
					const last = token.items[token.items.length - 1];
					if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
						if (top.type === "document") top.end = last.start;
						else top.items.push({ start: last.start });
						token.items.splice(-1, 1);
					}
				}
			}
		}
		*stream() {
			switch (this.type) {
				case "directive-line":
					yield {
						type: "directive",
						offset: this.offset,
						source: this.source
					};
					return;
				case "byte-order-mark":
				case "space":
				case "comment":
				case "newline":
					yield this.sourceToken;
					return;
				case "doc-mode":
				case "doc-start": {
					const doc = {
						type: "document",
						offset: this.offset,
						start: []
					};
					if (this.type === "doc-start") doc.start.push(this.sourceToken);
					this.stack.push(doc);
					return;
				}
			}
			yield {
				type: "error",
				offset: this.offset,
				message: `Unexpected ${this.type} token in YAML stream`,
				source: this.source
			};
		}
		*document(doc) {
			if (doc.value) return yield* this.lineEnd(doc);
			switch (this.type) {
				case "doc-start":
					if (findNonEmptyIndex(doc.start) !== -1) {
						yield* this.pop();
						yield* this.step();
					} else doc.start.push(this.sourceToken);
					return;
				case "anchor":
				case "tag":
				case "space":
				case "comment":
				case "newline":
					doc.start.push(this.sourceToken);
					return;
			}
			const bv = this.startBlockValue(doc);
			if (bv) this.stack.push(bv);
			else yield {
				type: "error",
				offset: this.offset,
				message: `Unexpected ${this.type} token in YAML document`,
				source: this.source
			};
		}
		*scalar(scalar) {
			if (this.type === "map-value-ind") {
				const start = getFirstKeyStartProps(getPrevProps(this.peek(2)));
				let sep;
				if (scalar.end) {
					sep = scalar.end;
					sep.push(this.sourceToken);
					delete scalar.end;
				} else sep = [this.sourceToken];
				const map = {
					type: "block-map",
					offset: scalar.offset,
					indent: scalar.indent,
					items: [{
						start,
						key: scalar,
						sep
					}]
				};
				this.onKeyLine = true;
				this.stack[this.stack.length - 1] = map;
			} else yield* this.lineEnd(scalar);
		}
		*blockScalar(scalar) {
			switch (this.type) {
				case "space":
				case "comment":
				case "newline":
					scalar.props.push(this.sourceToken);
					return;
				case "scalar":
					scalar.source = this.source;
					this.atNewLine = true;
					this.indent = 0;
					if (this.onNewLine) {
						let nl = this.source.indexOf("\n") + 1;
						while (nl !== 0) {
							this.onNewLine(this.offset + nl);
							nl = this.source.indexOf("\n", nl) + 1;
						}
					}
					yield* this.pop();
					break;
				/* istanbul ignore next should not happen */
				default:
					yield* this.pop();
					yield* this.step();
			}
		}
		*blockMap(map) {
			const it = map.items[map.items.length - 1];
			switch (this.type) {
				case "newline":
					this.onKeyLine = false;
					if (it.value) {
						const end = "end" in it.value ? it.value.end : void 0;
						if ((Array.isArray(end) ? end[end.length - 1] : void 0)?.type === "comment") end?.push(this.sourceToken);
						else map.items.push({ start: [this.sourceToken] });
					} else if (it.sep) it.sep.push(this.sourceToken);
					else it.start.push(this.sourceToken);
					return;
				case "space":
				case "comment":
					if (it.value) map.items.push({ start: [this.sourceToken] });
					else if (it.sep) it.sep.push(this.sourceToken);
					else {
						if (this.atIndentedComment(it.start, map.indent)) {
							const end = map.items[map.items.length - 2]?.value?.end;
							if (Array.isArray(end)) {
								arrayPushArray(end, it.start);
								end.push(this.sourceToken);
								map.items.pop();
								return;
							}
						}
						it.start.push(this.sourceToken);
					}
					return;
			}
			if (this.indent >= map.indent) {
				const atMapIndent = !this.onKeyLine && this.indent === map.indent;
				const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
				let start = [];
				if (atNextItem && it.sep && !it.value) {
					const nl = [];
					for (let i = 0; i < it.sep.length; ++i) {
						const st = it.sep[i];
						switch (st.type) {
							case "newline":
								nl.push(i);
								break;
							case "space": break;
							case "comment":
								if (st.indent > map.indent) nl.length = 0;
								break;
							default: nl.length = 0;
						}
					}
					if (nl.length >= 2) start = it.sep.splice(nl[1]);
				}
				switch (this.type) {
					case "anchor":
					case "tag":
						if (atNextItem || it.value) {
							start.push(this.sourceToken);
							map.items.push({ start });
							this.onKeyLine = true;
						} else if (it.sep) it.sep.push(this.sourceToken);
						else it.start.push(this.sourceToken);
						return;
					case "explicit-key-ind":
						if (!it.sep && !it.explicitKey) {
							it.start.push(this.sourceToken);
							it.explicitKey = true;
						} else if (atNextItem || it.value) {
							start.push(this.sourceToken);
							map.items.push({
								start,
								explicitKey: true
							});
						} else this.stack.push({
							type: "block-map",
							offset: this.offset,
							indent: this.indent,
							items: [{
								start: [this.sourceToken],
								explicitKey: true
							}]
						});
						this.onKeyLine = true;
						return;
					case "map-value-ind":
						if (it.explicitKey) {
							if (!it.sep) {
								if (includesToken(it.start, "newline")) Object.assign(it, {
									key: null,
									sep: [this.sourceToken]
								});
								else {
									const start = getFirstKeyStartProps(it.start);
									this.stack.push({
										type: "block-map",
										offset: this.offset,
										indent: this.indent,
										items: [{
											start,
											key: null,
											sep: [this.sourceToken]
										}]
									});
								}
							} else if (it.value) map.items.push({
								start: [],
								key: null,
								sep: [this.sourceToken]
							});
							else if (includesToken(it.sep, "map-value-ind")) this.stack.push({
								type: "block-map",
								offset: this.offset,
								indent: this.indent,
								items: [{
									start,
									key: null,
									sep: [this.sourceToken]
								}]
							});
							else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
								const start = getFirstKeyStartProps(it.start);
								const key = it.key;
								const sep = it.sep;
								sep.push(this.sourceToken);
								delete it.key;
								delete it.sep;
								this.stack.push({
									type: "block-map",
									offset: this.offset,
									indent: this.indent,
									items: [{
										start,
										key,
										sep
									}]
								});
							} else if (start.length > 0) it.sep = it.sep.concat(start, this.sourceToken);
							else it.sep.push(this.sourceToken);
						} else if (!it.sep) Object.assign(it, {
							key: null,
							sep: [this.sourceToken]
						});
						else if (it.value || atNextItem) map.items.push({
							start,
							key: null,
							sep: [this.sourceToken]
						});
						else if (includesToken(it.sep, "map-value-ind")) this.stack.push({
							type: "block-map",
							offset: this.offset,
							indent: this.indent,
							items: [{
								start: [],
								key: null,
								sep: [this.sourceToken]
							}]
						});
						else it.sep.push(this.sourceToken);
						this.onKeyLine = true;
						return;
					case "alias":
					case "scalar":
					case "single-quoted-scalar":
					case "double-quoted-scalar": {
						const fs = this.flowScalar(this.type);
						if (atNextItem || it.value) {
							map.items.push({
								start,
								key: fs,
								sep: []
							});
							this.onKeyLine = true;
						} else if (it.sep) this.stack.push(fs);
						else {
							Object.assign(it, {
								key: fs,
								sep: []
							});
							this.onKeyLine = true;
						}
						return;
					}
					default: {
						const bv = this.startBlockValue(map);
						if (bv) {
							if (bv.type === "block-seq") {
								if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
									yield* this.pop({
										type: "error",
										offset: this.offset,
										message: "Unexpected block-seq-ind on same line with key",
										source: this.source
									});
									return;
								}
							} else if (atMapIndent) map.items.push({ start });
							this.stack.push(bv);
							return;
						}
					}
				}
			}
			yield* this.pop();
			yield* this.step();
		}
		*blockSequence(seq) {
			const it = seq.items[seq.items.length - 1];
			switch (this.type) {
				case "newline":
					if (it.value) {
						const end = "end" in it.value ? it.value.end : void 0;
						if ((Array.isArray(end) ? end[end.length - 1] : void 0)?.type === "comment") end?.push(this.sourceToken);
						else seq.items.push({ start: [this.sourceToken] });
					} else it.start.push(this.sourceToken);
					return;
				case "space":
				case "comment":
					if (it.value) seq.items.push({ start: [this.sourceToken] });
					else {
						if (this.atIndentedComment(it.start, seq.indent)) {
							const end = seq.items[seq.items.length - 2]?.value?.end;
							if (Array.isArray(end)) {
								arrayPushArray(end, it.start);
								end.push(this.sourceToken);
								seq.items.pop();
								return;
							}
						}
						it.start.push(this.sourceToken);
					}
					return;
				case "anchor":
				case "tag":
					if (it.value || this.indent <= seq.indent) break;
					it.start.push(this.sourceToken);
					return;
				case "seq-item-ind":
					if (this.indent !== seq.indent) break;
					if (it.value || includesToken(it.start, "seq-item-ind")) seq.items.push({ start: [this.sourceToken] });
					else it.start.push(this.sourceToken);
					return;
			}
			if (this.indent > seq.indent) {
				const bv = this.startBlockValue(seq);
				if (bv) {
					this.stack.push(bv);
					return;
				}
			}
			yield* this.pop();
			yield* this.step();
		}
		*flowCollection(fc) {
			const it = fc.items[fc.items.length - 1];
			if (this.type === "flow-error-end") {
				let top;
				do {
					yield* this.pop();
					top = this.peek(1);
				} while (top?.type === "flow-collection");
			} else if (fc.end.length === 0) {
				switch (this.type) {
					case "comma":
					case "explicit-key-ind":
						if (!it || it.sep) fc.items.push({ start: [this.sourceToken] });
						else it.start.push(this.sourceToken);
						return;
					case "map-value-ind":
						if (!it || it.value) fc.items.push({
							start: [],
							key: null,
							sep: [this.sourceToken]
						});
						else if (it.sep) it.sep.push(this.sourceToken);
						else Object.assign(it, {
							key: null,
							sep: [this.sourceToken]
						});
						return;
					case "space":
					case "comment":
					case "newline":
					case "anchor":
					case "tag":
						if (!it || it.value) fc.items.push({ start: [this.sourceToken] });
						else if (it.sep) it.sep.push(this.sourceToken);
						else it.start.push(this.sourceToken);
						return;
					case "alias":
					case "scalar":
					case "single-quoted-scalar":
					case "double-quoted-scalar": {
						const fs = this.flowScalar(this.type);
						if (!it || it.value) fc.items.push({
							start: [],
							key: fs,
							sep: []
						});
						else if (it.sep) this.stack.push(fs);
						else Object.assign(it, {
							key: fs,
							sep: []
						});
						return;
					}
					case "flow-map-end":
					case "flow-seq-end":
						fc.end.push(this.sourceToken);
						return;
				}
				const bv = this.startBlockValue(fc);
				/* istanbul ignore else should not happen */
				if (bv) this.stack.push(bv);
				else {
					yield* this.pop();
					yield* this.step();
				}
			} else {
				const parent = this.peek(2);
				if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
					yield* this.pop();
					yield* this.step();
				} else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
					const start = getFirstKeyStartProps(getPrevProps(parent));
					fixFlowSeqItems(fc);
					const sep = fc.end.splice(1, fc.end.length);
					sep.push(this.sourceToken);
					const map = {
						type: "block-map",
						offset: fc.offset,
						indent: fc.indent,
						items: [{
							start,
							key: fc,
							sep
						}]
					};
					this.onKeyLine = true;
					this.stack[this.stack.length - 1] = map;
				} else yield* this.lineEnd(fc);
			}
		}
		flowScalar(type) {
			if (this.onNewLine) {
				let nl = this.source.indexOf("\n") + 1;
				while (nl !== 0) {
					this.onNewLine(this.offset + nl);
					nl = this.source.indexOf("\n", nl) + 1;
				}
			}
			return {
				type,
				offset: this.offset,
				indent: this.indent,
				source: this.source
			};
		}
		startBlockValue(parent) {
			switch (this.type) {
				case "alias":
				case "scalar":
				case "single-quoted-scalar":
				case "double-quoted-scalar": return this.flowScalar(this.type);
				case "block-scalar-header": return {
					type: "block-scalar",
					offset: this.offset,
					indent: this.indent,
					props: [this.sourceToken],
					source: ""
				};
				case "flow-map-start":
				case "flow-seq-start": return {
					type: "flow-collection",
					offset: this.offset,
					indent: this.indent,
					start: this.sourceToken,
					items: [],
					end: []
				};
				case "seq-item-ind": return {
					type: "block-seq",
					offset: this.offset,
					indent: this.indent,
					items: [{ start: [this.sourceToken] }]
				};
				case "explicit-key-ind": {
					this.onKeyLine = true;
					const start = getFirstKeyStartProps(getPrevProps(parent));
					start.push(this.sourceToken);
					return {
						type: "block-map",
						offset: this.offset,
						indent: this.indent,
						items: [{
							start,
							explicitKey: true
						}]
					};
				}
				case "map-value-ind": {
					this.onKeyLine = true;
					const start = getFirstKeyStartProps(getPrevProps(parent));
					return {
						type: "block-map",
						offset: this.offset,
						indent: this.indent,
						items: [{
							start,
							key: null,
							sep: [this.sourceToken]
						}]
					};
				}
			}
			return null;
		}
		atIndentedComment(start, indent) {
			if (this.type !== "comment") return false;
			if (this.indent <= indent) return false;
			return start.every((st) => st.type === "newline" || st.type === "space");
		}
		*documentEnd(docEnd) {
			if (this.type !== "doc-mode") {
				if (docEnd.end) docEnd.end.push(this.sourceToken);
				else docEnd.end = [this.sourceToken];
				if (this.type === "newline") yield* this.pop();
			}
		}
		*lineEnd(token) {
			switch (this.type) {
				case "comma":
				case "doc-start":
				case "doc-end":
				case "flow-seq-end":
				case "flow-map-end":
				case "map-value-ind":
					yield* this.pop();
					yield* this.step();
					break;
				case "newline": this.onKeyLine = false;
				default:
					if (token.end) token.end.push(this.sourceToken);
					else token.end = [this.sourceToken];
					if (this.type === "newline") yield* this.pop();
			}
		}
	};
	exports.Parser = Parser;
}));

// node_modules/yaml/dist/public-api.js
var require_public_api = /* @__PURE__ */ __commonJSMin(((exports) => {
	var composer = require_composer();
	var Document = require_Document();
	var errors = require_errors();
	var log = require_log();
	var identity = require_identity();
	var lineCounter = require_line_counter();
	var parser = require_parser();
	function parseOptions(options) {
		const prettyErrors = options.prettyErrors !== false;
		return {
			lineCounter: options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null,
			prettyErrors
		};
	}
	/**
	* Parse the input as a stream of YAML documents.
	*
	* Documents should be separated from each other by `...` or `---` marker lines.
	*
	* @returns If an empty `docs` array is returned, it will be of type
	*   EmptyStream and contain additional stream information. In
	*   TypeScript, you should use `'empty' in docs` as a type guard for it.
	*/
	function parseAllDocuments(source, options = {}) {
		const { lineCounter, prettyErrors } = parseOptions(options);
		const parser$1 = new parser.Parser(lineCounter?.addNewLine);
		const composer$1 = new composer.Composer(options);
		const docs = Array.from(composer$1.compose(parser$1.parse(source)));
		if (prettyErrors && lineCounter) for (const doc of docs) {
			doc.errors.forEach(errors.prettifyError(source, lineCounter));
			doc.warnings.forEach(errors.prettifyError(source, lineCounter));
		}
		if (docs.length > 0) return docs;
		return Object.assign([], { empty: true }, composer$1.streamInfo());
	}
	/** Parse an input string into a single YAML.Document */
	function parseDocument(source, options = {}) {
		const { lineCounter, prettyErrors } = parseOptions(options);
		const parser$1 = new parser.Parser(lineCounter?.addNewLine);
		const composer$1 = new composer.Composer(options);
		let doc = null;
		for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) if (!doc) doc = _doc;
		else if (doc.options.logLevel !== "silent") {
			doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
			break;
		}
		if (prettyErrors && lineCounter) {
			doc.errors.forEach(errors.prettifyError(source, lineCounter));
			doc.warnings.forEach(errors.prettifyError(source, lineCounter));
		}
		return doc;
	}
	function parse(src, reviver, options) {
		let _reviver = void 0;
		if (typeof reviver === "function") _reviver = reviver;
		else if (options === void 0 && reviver && typeof reviver === "object") options = reviver;
		const doc = parseDocument(src, options);
		if (!doc) return null;
		doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
		if (doc.errors.length > 0) {
			if (doc.options.logLevel !== "silent") throw doc.errors[0];
			else doc.errors = [];
		}
		return doc.toJS(Object.assign({ reviver: _reviver }, options));
	}
	function stringify(value, replacer, options) {
		let _replacer = null;
		if (typeof replacer === "function" || Array.isArray(replacer)) _replacer = replacer;
		else if (options === void 0 && replacer) options = replacer;
		if (typeof options === "string") options = options.length;
		if (typeof options === "number") {
			const indent = Math.round(options);
			options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
		}
		if (value === void 0) {
			const { keepUndefined } = options ?? replacer ?? {};
			if (!keepUndefined) return void 0;
		}
		if (identity.isDocument(value) && !_replacer) return value.toString(options);
		return new Document.Document(value, _replacer, options).toString(options);
	}
	exports.parse = parse;
	exports.parseAllDocuments = parseAllDocuments;
	exports.parseDocument = parseDocument;
	exports.stringify = stringify;
}));

// node_modules/yaml/dist/index.js
var require_dist = /* @__PURE__ */ __commonJSMin(((exports) => {
	var composer = require_composer();
	var Document = require_Document();
	var Schema = require_Schema();
	var errors = require_errors();
	var Alias = require_Alias();
	var identity = require_identity();
	var Pair = require_Pair();
	var Scalar = require_Scalar();
	var YAMLMap = require_YAMLMap();
	var YAMLSeq = require_YAMLSeq();
	var cst = require_cst();
	var lexer = require_lexer();
	var lineCounter = require_line_counter();
	var parser = require_parser();
	var publicApi = require_public_api();
	var visit = require_visit();
	exports.Composer = composer.Composer;
	exports.Document = Document.Document;
	exports.Schema = Schema.Schema;
	exports.YAMLError = errors.YAMLError;
	exports.YAMLParseError = errors.YAMLParseError;
	exports.YAMLWarning = errors.YAMLWarning;
	exports.Alias = Alias.Alias;
	exports.isAlias = identity.isAlias;
	exports.isCollection = identity.isCollection;
	exports.isDocument = identity.isDocument;
	exports.isMap = identity.isMap;
	exports.isNode = identity.isNode;
	exports.isPair = identity.isPair;
	exports.isScalar = identity.isScalar;
	exports.isSeq = identity.isSeq;
	exports.Pair = Pair.Pair;
	exports.Scalar = Scalar.Scalar;
	exports.YAMLMap = YAMLMap.YAMLMap;
	exports.YAMLSeq = YAMLSeq.YAMLSeq;
	exports.Lexer = lexer.Lexer;
	exports.LineCounter = lineCounter.LineCounter;
	exports.Parser = parser.Parser;
	exports.parse = publicApi.parse;
	exports.parseAllDocuments = publicApi.parseAllDocuments;
	exports.parseDocument = publicApi.parseDocument;
	exports.stringify = publicApi.stringify;
	exports.visit = visit.visit;
	exports.visitAsync = visit.visitAsync;
}));

// src/evidence/actions-yaml.ts
var import_dist = require_dist();
var YamlFailure = class extends Error {
	reason;
	constructor(reason) {
		super(reason);
		this.reason = reason;
	}
};
function need$1(value, reason = "malformed") {
	if (!value) throw new YamlFailure(reason);
}
function safeIdentity(value, units = 256) {
	return typeof value === "string" && value.length > 0 && value.length <= units && Buffer.byteLength(value) <= 1024 && !/[\p{Cc}\p{Cs}]/u.test(value);
}
function debit$1(budget, key, limit) {
	need$1(budget[key] < limit, "budget");
	budget[key]++;
}
function preflight(value, limits, budget) {
	const stack = [{
		value,
		depth: 0
	}];
	while (stack.length) {
		const { value: item, depth } = stack.pop();
		if (!item || typeof item !== "object") continue;
		const r = item;
		const collection = [
			"block-map",
			"block-seq",
			"flow-collection"
		].includes(r.type);
		const next = depth + Number(collection);
		need$1(next <= limits.maxYamlDepth, "budget");
		debit$1(budget, "nodes", limits.maxYamlNodes);
		if (r.type === "tag") need$1([
			"!!str",
			"!!int",
			"!!float",
			"!!bool",
			"!!null",
			"!!map",
			"!!seq"
		].includes(r.source), "unsupported");
		if (r.type === "directive") need$1(r.source === "%YAML 1.2", "unsupported");
		const children = Object.values(r).flatMap((child) => Array.isArray(child) ? child.toReversed() : [child]);
		for (const child of children) stack.push({
			value: child,
			depth: next
		});
	}
}
function children(node) {
	if ((0, import_dist.isSeq)(node)) return node.items.filter((n) => n !== null);
	if (!(0, import_dist.isMap)(node)) return [];
	return node.items.flatMap((p) => [p.key, p.value].filter((n) => n !== null));
}
function aliases(root) {
	const anchors = /* @__PURE__ */ new Map();
	const targets = /* @__PURE__ */ new Map();
	const pending = [root];
	while (pending.length) {
		const node = pending.pop();
		if ((0, import_dist.isAlias)(node)) {
			const target = anchors.get(node.source);
			need$1(target);
			targets.set(node, target);
		} else {
			if (node.anchor) anchors.set(node.anchor, node);
			const list = children(node);
			for (let i = list.length - 1; i >= 0; i--) pending.push(list[i]);
		}
	}
	return targets;
}
function queueCollection(node, frame, stack) {
	const depth = frame.depth + 1;
	if ((0, import_dist.isSeq)(node)) {
		const out = [];
		frame.assign(out);
		for (let i = node.items.length - 1; i >= 0; i--) {
			const child = node.items[i];
			need$1(child === null || (0, import_dist.isNode)(child));
			stack.push({
				node: child,
				depth,
				assign: (v) => {
					out[i] = v;
				}
			});
		}
	} else {
		need$1((0, import_dist.isMap)(node));
		const out = /* @__PURE__ */ new Map();
		frame.assign(out);
		for (let i = node.items.length - 1; i >= 0; i--) {
			const pair = node.items[i];
			need$1((0, import_dist.isScalar)(pair.key) && typeof pair.key.value === "string");
			const key = pair.key.value;
			need$1(key !== "<<", "unsupported");
			need$1(pair.value === null || (0, import_dist.isNode)(pair.value));
			stack.push({
				node: pair.value,
				depth,
				assign: (v) => {
					out.set(key, v);
				}
			});
		}
	}
}
function expand(root, limits, budget) {
	const targets = aliases(root), active = /* @__PURE__ */ new Set();
	let result = null;
	const stack = [{
		node: root,
		depth: 0,
		assign: (v) => {
			result = v;
		}
	}];
	while (stack.length) {
		const frame = stack.pop();
		if ("leave" in frame) {
			active.delete(frame.leave);
			continue;
		}
		const { node, depth, assign } = frame;
		if (!node) {
			assign(null);
			continue;
		}
		debit$1(budget, "nodes", limits.maxYamlNodes);
		need$1(!active.has(node), "unsupported");
		if ((0, import_dist.isAlias)(node)) {
			debit$1(budget, "aliases", limits.maxAliasExpansions);
			stack.push({
				node: targets.get(node),
				depth,
				assign
			});
		} else if ((0, import_dist.isScalar)(node)) {
			need$1(node.value === null || [
				"string",
				"number",
				"boolean"
			].includes(typeof node.value));
			assign(node.value);
		} else {
			need$1(depth < limits.maxYamlDepth, "budget");
			active.add(node);
			stack.push({ leave: node });
			queueCollection(node, frame, stack);
		}
	}
	return result;
}
function use(value, budget, limits) {
	debit$1(budget, "occurrences", limits.maxOccurrences);
	need$1(typeof value === "string");
	need$1(safeIdentity(value, 2048));
	need$1(!value.includes("${{") && !value.startsWith("docker:"), "unsupported");
	if (value.startsWith("./")) {
		need$1(value.slice(2).split("/").every((s) => s && s !== "." && s !== ".." && !/[\\:]/u.test(s)));
		return {
			kind: "local",
			path: value
		};
	}
	const at = value.indexOf("@");
	need$1(at > 0 && at < value.length - 1);
	const action = value.slice(0, at), ref = value.slice(at + 1);
	need$1(safeIdentity(action) && safeIdentity(ref, 1024));
	need$1(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(action));
	need$1(action.split("/").every((s) => s !== "." && s !== ".."));
	need$1(!/[\s\\]|[?&](?:token|key|password|secret|auth)=/iu.test(ref));
	return {
		kind: "external",
		action,
		ref,
		refKind: /^[a-f\d]{40}$/iu.test(ref) ? "sha" : "unknown"
	};
}
function readUse(raw, jobId, stepIndex, state) {
	try {
		return use(raw, state.budget, state.limits);
	} catch (e) {
		if (e instanceof YamlFailure && e.reason === "budget") throw e;
		state.gaps.push({
			jobId,
			stepIndex,
			reason: e instanceof YamlFailure ? e.reason : "malformed"
		});
		return { kind: "unsupported" };
	}
}
function readStep(step, jobId, stepIndex, state) {
	if (!(step instanceof Map)) {
		state.gaps.push({
			jobId,
			stepIndex,
			reason: "malformed"
		});
		return {
			id: null,
			use: { kind: "unsupported" }
		};
	}
	const id = step.get("id");
	if (id !== void 0 && !safeIdentity(id)) state.gaps.push({
		jobId,
		stepIndex,
		reason: "malformed"
	});
	return {
		id: safeIdentity(id) ? id : null,
		use: step.has("uses") ? readUse(step.get("uses"), jobId, stepIndex, state) : null
	};
}
function readJob(jobId, raw, state) {
	if (!safeIdentity(jobId) || !(raw instanceof Map)) {
		state.gaps.push({
			jobId: safeIdentity(jobId) ? jobId : null,
			stepIndex: null,
			reason: "malformed"
		});
		return null;
	}
	const job = {
		jobId,
		steps: null,
		use: null
	};
	if (raw.has("uses")) job.use = readUse(raw.get("uses"), jobId, null, state);
	if (raw.has("steps")) {
		const steps = raw.get("steps");
		if (!Array.isArray(steps) || job.use) state.gaps.push({
			jobId,
			stepIndex: null,
			reason: "malformed"
		});
		else job.steps = steps.map((step, i) => readStep(step, jobId, i, state));
	} else if (!job.use) state.gaps.push({
		jobId,
		stepIndex: null,
		reason: "malformed"
	});
	return job;
}
function extract(value, budget, limits) {
	need$1(value instanceof Map);
	const rawJobs = value.get("jobs");
	need$1(rawJobs instanceof Map);
	const jobs = [], gaps = [];
	for (const [jobId, raw] of [...rawJobs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
		const job = readJob(jobId, raw, {
			budget,
			limits,
			gaps
		});
		if (job) jobs.push(job);
	}
	return {
		kind: "parsed",
		jobs,
		gaps
	};
}
/** Parses bounded immutable bytes only; caller owns cumulative budget across revisions/files. */
function readWorkflow(bytes, limits, budget = {
	nodes: 0,
	aliases: 0,
	occurrences: 0
}) {
	try {
		need$1(bytes.byteLength <= limits.maxFileBytes, "budget");
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		const tokens = [];
		for (const token of new import_dist.Parser().parse(text)) {
			preflight(token, limits, budget);
			tokens.push(token);
		}
		const docs = [...new import_dist.Composer({
			version: "1.2",
			schema: "core",
			strict: true,
			stringKeys: true,
			uniqueKeys: true,
			merge: false,
			resolveKnownTags: false,
			prettyErrors: false,
			logLevel: "silent"
		}).compose(tokens)];
		need$1(docs.length === 1 && docs[0].errors.length === 0);
		need$1(docs[0].warnings.length === 0, "unsupported");
		need$1(docs[0].contents);
		return extract(expand(docs[0].contents, limits, budget), budget, limits);
	} catch (e) {
		return {
			kind: "unavailable",
			reason: e instanceof YamlFailure ? e.reason : "malformed"
		};
	}
}

// src/event.ts
function positiveId(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// src/schema.ts
const PACKET_LIMITS = Object.freeze({
	bytes: 1048576,
	changes: 128,
	sources: 1024,
	findings: 512,
	relationships: 256,
	pathInstances: 32,
	idCodeUnits: 256,
	identityBytes: 1024,
	textBytes: 2048,
	listEntries: 32,
	contextBytes: 65536,
	excerptCodeUnits: 500,
	facts: 20
});

// src/evidence/common.ts
/** Plain data only: no proxy, foreign prototype, accessor, symbol, or prototype-shaped key. */
function isPlainObject(value) {
	if (!value || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	return Reflect.ownKeys(descriptors).every((k) => typeof k === "string" && ![
		"__proto__",
		"constructor",
		"prototype"
	].includes(k) && "value" in descriptors[k]);
}
function freeze(value) {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

// src/evidence/advisory-read.ts
var AdvisoryFailure = class extends Error {
	reason;
	constructor(reason) {
		super(reason);
		this.reason = reason;
	}
};
function advisoryCheck(value, reason = "malformed") {
	if (!value) throw new AdvisoryFailure(reason);
}
function advisoryText(value) {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= PACKET_LIMITS.identityBytes && !/[\p{Cc}\p{Cs}]/u.test(value);
}

// src/evidence/bounded-request.ts
function boundedLimits(value) {
	advisoryCheck(isPlainObject(value));
	const keys = [
		"maxRequests",
		"maxResponseBytes",
		"maxTotalBytes",
		"maxJsonEntries",
		"maxJsonDepth",
		"maxWork",
		"maxRetainedBytes",
		"requestTimeoutMs",
		"totalTimeoutMs"
	];
	advisoryCheck(keys.every((k) => Number.isSafeInteger(value[k]) && Number(value[k]) > 0));
	advisoryCheck(Number(value.maxResponseBytes) <= Number(value.maxTotalBytes) && Number(value.requestTimeoutMs) <= Number(value.totalTimeoutMs) && Number(value.requestTimeoutMs) <= 2 ** 31 - 1);
	return Object.fromEntries(keys.map((k) => [k, value[k]]));
}
/** Wall-clock budget shared by every request of one reader; a non-monotonic clock is unknown. */
var BoundedClock = class {
	totalTimeoutMs;
	deps;
	started;
	last;
	constructor(totalTimeoutMs, deps) {
		this.totalTimeoutMs = totalTimeoutMs;
		this.deps = deps;
		this.started = this.last = deps.now();
		advisoryCheck(Number.isFinite(this.started));
	}
	remaining(stopped) {
		advisoryCheck(!stopped && !this.deps.signal?.aborted, stopped ?? "unknown");
		const now = this.deps.now();
		advisoryCheck(Number.isFinite(now) && now >= this.last, "unknown");
		this.last = now;
		const left = this.totalTimeoutMs - (now - this.started);
		advisoryCheck(left > 0, "timeout");
		return left;
	}
};
/**
* One credential-free GET raced against its timeout, the caller's signal, and `onCancel`
* (registered for the reader's close). Every exit aborts the request and releases its body.
*/
async function boundedGet(deps, request, onCancel, consume) {
	const controller = new AbortController();
	let reject = () => {};
	const aborted = new Promise((_, r) => {
		reject = r;
	});
	const stop = (reason) => {
		controller.abort();
		reject(new AdvisoryFailure(reason));
	};
	const cancel = () => stop("unknown");
	onCancel(cancel);
	deps.signal?.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(() => stop("timeout"), request.timeoutMs);
	let response;
	try {
		response = await Promise.race([deps.fetch(request.url, {
			method: "GET",
			redirect: "manual",
			credentials: "omit",
			headers: { accept: request.accept },
			signal: controller.signal
		}), aborted]);
		return await consume(response, aborted);
	} finally {
		clearTimeout(timer);
		deps.signal?.removeEventListener("abort", cancel);
		onCancel(null);
		controller.abort();
		if (response?.body && !response.body.locked) response.body.cancel().catch(() => {});
	}
}

// src/evidence/npm-publish-times.ts
function target(value) {
	advisoryCheck(isPlainObject(value) && isPlainObject(value.source), "unsupported");
	const v = value, source = v.source;
	advisoryCheck(advisoryText(v.name) && /^(?:@[a-z\d][a-z\d._-]*\/)?[a-z\d][a-z\d._-]*$/iu.test(v.name), "unsupported");
	advisoryCheck(source.kind === "registry" && typeof source.identity === "string", "unsupported");
	const origin = new URL(source.identity);
	advisoryCheck(origin.origin === "https://registry.npmjs.org" && !origin.username && !origin.password && !origin.search && !origin.hash, "unsupported");
	advisoryCheck(Array.isArray(v.versions) && !types.isProxy(v.versions) && Object.getPrototypeOf(v.versions) === Array.prototype && v.versions.length > 0 && v.versions.length <= 2, "unsupported");
	advisoryCheck(Reflect.ownKeys(v.versions).every((k) => typeof k === "string" && (k === "length" || /^(?:0|[1-9]\d*)$/u.test(k)) && "value" in Object.getOwnPropertyDescriptor(v.versions, k)), "unsupported");
	advisoryCheck(v.versions.every((x) => advisoryText(x) && !/[/\s@,]/u.test(x)), "unsupported");
	advisoryCheck(Number.isSafeInteger(v.evaluationTime) && Number(v.evaluationTime) >= 0);
	return {
		name: v.name,
		versions: [...new Set(v.versions)],
		source: {
			kind: "registry",
			identity: String(source.identity)
		},
		evaluationTime: Number(v.evaluationTime)
	};
}
function publishTimestamp(value, evaluationTime) {
	if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(value)) return null;
	const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
	if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return null;
	const time = Date.parse(value);
	return Number.isSafeInteger(time) && time >= 0 && time <= evaluationTime ? time : null;
}
function extractor(t, limits, spend) {
	const frames = [], times = {}, reasons = {};
	const seen = /* @__PURE__ */ new Set();
	let text = "", collectingKey = false, capture = null, nameSeen = false, timeSeen = false;
	const keyLimit = Math.max(4, ...t.versions.map((v) => v.length));
	function selected() {
		const f = frames.at(-1);
		return frames.length === 2 && timeSeen && frames[0].key === "time" && f?.kind === "object" && f.key && t.versions.includes(f.key) ? f.key : null;
	}
	function beginValue(kind) {
		const f = frames.at(-1);
		if (frames.length === 1 && f?.key === "time") {
			advisoryCheck(kind === "object");
			advisoryCheck(!timeSeen, "conflict");
			timeSeen = true;
		}
		if (frames.length === 1 && f?.key === "name") {
			advisoryCheck(kind === "string");
			advisoryCheck(!nameSeen, "conflict");
			nameSeen = true;
			return "name";
		}
		const version = selected();
		if (version) {
			advisoryCheck(!seen.has(version), "conflict");
			seen.add(version);
			if (kind !== "string") reasons[version] = "malformed";
			return kind === "string" ? version : null;
		}
		return null;
	}
	function appendText(value) {
		if (collectingKey) {
			if (text.length <= keyLimit) text = (text + value).slice(0, keyLimit + 1);
		} else if (capture) {
			text += value;
			advisoryCheck(Buffer.byteLength(text) <= PACKET_LIMITS.identityBytes, "budget");
		}
	}
	function finishString() {
		if (capture === "name") advisoryCheck(text === t.name, "conflict");
		else if (capture) {
			const time = publishTimestamp(text, t.evaluationTime);
			if (time === null) reasons[capture] = Number.isFinite(Date.parse(text)) && Date.parse(text) > t.evaluationTime ? "conflict" : "malformed";
			else times[capture] = time;
		}
		capture = null;
	}
	function accept(token) {
		spend();
		switch (token.name) {
			case "startObject":
			case "startArray":
				beginValue(token.name === "startObject" ? "object" : "array");
				advisoryCheck(frames.length || token.name === "startObject");
				frames.push({
					kind: token.name === "startObject" ? "object" : "array",
					key: null
				});
				advisoryCheck(frames.length <= limits.maxJsonDepth, "budget");
				break;
			case "endObject":
			case "endArray":
				frames.pop();
				break;
			case "startKey":
				collectingKey = true;
				text = "";
				break;
			case "endKey":
				frames.at(-1).key = text.length <= keyLimit ? text : null;
				collectingKey = false;
				break;
			case "startString":
				capture = beginValue("string");
				text = "";
				break;
			case "stringChunk":
				appendText(token.value);
				break;
			case "endString":
				finishString();
				break;
			case "startNumber":
			case "trueValue":
			case "falseValue":
			case "nullValue": beginValue("other");
		}
	}
	return {
		accept,
		finish() {
			advisoryCheck(nameSeen && timeSeen, "missing");
			for (const v of t.versions) if (times[v] === void 0 && !reasons[v]) reasons[v] = "missing";
			advisoryCheck(Object.keys(times).length + Object.keys(reasons).length <= limits.maxJsonEntries, "budget");
			return {
				times,
				reasons
			};
		}
	};
}
function validateResponse(response, url) {
	advisoryCheck(!response.redirected && (!response.url || response.url === url), "unsupported");
	if (response.status === 429) throw new AdvisoryFailure("rate_limit");
	if (response.status !== 200) throw new AdvisoryFailure(response.status === 404 ? "missing" : [401, 403].includes(response.status) ? "permission" : response.status >= 300 && response.status < 400 ? "unsupported" : "unknown");
	advisoryCheck(/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? ""), "unsupported");
}
var TimeReader = class {
	limits;
	deps;
	requests = 0;
	bytes = 0;
	work = 0;
	clock;
	stopped = false;
	busy = false;
	active = null;
	retained = 0;
	cache = /* @__PURE__ */ new Map();
	constructor(limits, deps) {
		this.limits = limits;
		this.deps = deps;
		this.clock = new BoundedClock(limits.totalTimeoutMs, deps);
	}
	close() {
		this.stopped = true;
		this.active?.();
	}
	remaining() {
		return this.clock.remaining(this.stopped ? "unknown" : null);
	}
	spend = () => {
		advisoryCheck(++this.work <= this.limits.maxWork, "budget");
		this.remaining();
	};
	async fetch(t) {
		advisoryCheck(++this.requests <= this.limits.maxRequests, "budget");
		const timeoutMs = Math.min(this.remaining(), this.limits.requestTimeoutMs);
		const url = "https://registry.npmjs.org/" + encodeURIComponent(t.name);
		return boundedGet(this.deps, {
			url,
			accept: "application/json",
			timeoutMs
		}, (cancel) => {
			this.active = cancel;
		}, async (response, aborted) => {
			validateResponse(response, url);
			advisoryCheck(response.body);
			const stream = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
			let size = 0;
			const state = extractor(t, this.limits, this.spend);
			const debitBytes = (count) => {
				size += count;
				this.bytes += count;
				advisoryCheck(size <= this.limits.maxResponseBytes && this.bytes <= this.limits.maxTotalBytes, "budget");
				this.remaining();
			};
			async function* chunks() {
				try {
					for (;;) {
						const part = await Promise.race([stream.read().catch(() => {
							throw new AdvisoryFailure("unknown");
						}), aborted]);
						if (part.done) break;
						debitBytes(part.value.byteLength);
						for (let i = 0; i < part.value.length; i += PACKET_LIMITS.textBytes) yield decoder.decode(part.value.subarray(i, i + PACKET_LIMITS.textBytes), { stream: true });
					}
					yield decoder.decode();
				} finally {
					stream.cancel().catch(() => {});
					stream.releaseLock();
				}
			}
			try {
				await pipeline(Readable.from(chunks()), parser_default.asStream({
					packValues: false,
					streamValues: true,
					jsonStreaming: false
				}), async (tokens) => {
					for await (const token of tokens) state.accept(token);
				});
			} catch (error) {
				throw error instanceof AdvisoryFailure ? error : new AdvisoryFailure("malformed");
			}
			const result = {
				kind: "times",
				url,
				...state.finish()
			};
			advisoryCheck(Buffer.byteLength(JSON.stringify(result)) <= this.limits.maxRetainedBytes, "budget");
			return freeze(result);
		});
	}
	async read(value) {
		if (this.busy) return {
			kind: "unavailable",
			reason: "conflict"
		};
		this.busy = true;
		try {
			this.remaining();
			const t = target(value), key = JSON.stringify(t);
			const cached = this.cache.get(key);
			if (cached) return cached;
			let result;
			try {
				result = await this.fetch(t);
			} catch (error) {
				result = {
					kind: "unavailable",
					reason: error instanceof AdvisoryFailure ? error.reason : "unknown"
				};
			}
			const retained = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(result));
			advisoryCheck(this.retained + retained <= this.limits.maxRetainedBytes, "budget");
			this.retained += retained;
			this.cache.set(key, result);
			return result;
		} catch (error) {
			return {
				kind: "unavailable",
				reason: error instanceof AdvisoryFailure ? error.reason : "unknown"
			};
		} finally {
			this.busy = false;
		}
	}
};
function createNpmPublishTimeReader(value, dependencies) {
	try {
		const limits = boundedLimits(value), reader = new TimeReader(limits, dependencies);
		return Object.freeze({
			kind: "ready",
			limits: freeze(limits),
			read: (v) => reader.read(v),
			close: () => reader.close()
		});
	} catch {
		return { kind: "invalid" };
	}
}

// node_modules/spdx-license-ids/index.json
var require_spdx_license_ids = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = [
		"0BSD",
		"3D-Slicer-1.0",
		"AAL",
		"ADSL",
		"AFL-1.1",
		"AFL-1.2",
		"AFL-2.0",
		"AFL-2.1",
		"AFL-3.0",
		"AGPL-1.0-only",
		"AGPL-1.0-or-later",
		"AGPL-3.0-only",
		"AGPL-3.0-or-later",
		"ALGLIB-Documentation",
		"AMD-newlib",
		"AMDPLPA",
		"AML",
		"AML-glslang",
		"AMPAS",
		"ANTLR-PD",
		"ANTLR-PD-fallback",
		"APAFML",
		"APL-1.0",
		"APSL-1.0",
		"APSL-1.1",
		"APSL-1.2",
		"APSL-2.0",
		"ASWF-Digital-Assets-1.0",
		"ASWF-Digital-Assets-1.1",
		"Abstyles",
		"AdaCore-doc",
		"Adobe-2006",
		"Adobe-Display-PostScript",
		"Adobe-Glyph",
		"Adobe-Utopia",
		"Advanced-Cryptics-Dictionary",
		"Afmparse",
		"Aladdin",
		"Apache-1.0",
		"Apache-1.1",
		"Apache-2.0",
		"App-s2p",
		"Arphic-1999",
		"Artistic-1.0",
		"Artistic-1.0-Perl",
		"Artistic-1.0-cl8",
		"Artistic-2.0",
		"Artistic-dist",
		"Aspell-RU",
		"BOLA-1.1",
		"BSD-1-Clause",
		"BSD-2-Clause",
		"BSD-2-Clause-Darwin",
		"BSD-2-Clause-Patent",
		"BSD-2-Clause-Views",
		"BSD-2-Clause-first-lines",
		"BSD-2-Clause-pkgconf-disclaimer",
		"BSD-2-Clause-pos-unchanged",
		"BSD-3-Clause",
		"BSD-3-Clause-Attribution",
		"BSD-3-Clause-Clear",
		"BSD-3-Clause-HP",
		"BSD-3-Clause-LBNL",
		"BSD-3-Clause-Modification",
		"BSD-3-Clause-No-Military-License",
		"BSD-3-Clause-No-Nuclear-License",
		"BSD-3-Clause-No-Nuclear-License-2014",
		"BSD-3-Clause-No-Nuclear-Warranty",
		"BSD-3-Clause-Open-MPI",
		"BSD-3-Clause-OpenWebUI",
		"BSD-3-Clause-Sun",
		"BSD-3-Clause-Tso",
		"BSD-3-Clause-acpica",
		"BSD-3-Clause-flex",
		"BSD-4-Clause",
		"BSD-4-Clause-Shortened",
		"BSD-4-Clause-UC",
		"BSD-4.3RENO",
		"BSD-4.3TAHOE",
		"BSD-Advertising-Acknowledgement",
		"BSD-Attribution-HPND-disclaimer",
		"BSD-Inferno-Nettverk",
		"BSD-Mark-Modifications",
		"BSD-Protection",
		"BSD-Source-Code",
		"BSD-Source-Code-no-disclaimer",
		"BSD-Source-alt-GPL",
		"BSD-Source-beginning-file",
		"BSD-Systemics",
		"BSD-Systemics-W3Works",
		"BSD-ask-to-endorse",
		"BSL-1.0",
		"BUSL-1.1",
		"Baekmuk",
		"Bahyph",
		"Barr",
		"Beerware",
		"BitTorrent-1.0",
		"BitTorrent-1.1",
		"Bitstream-Charter",
		"Bitstream-Vera",
		"BlueOak-1.0.0",
		"Boehm-GC",
		"Boehm-GC-without-fee",
		"Borceux",
		"Brian-Gladman-2-Clause",
		"Brian-Gladman-3-Clause",
		"Brian-Gladman-3-Clause-no-conversion",
		"Buddy",
		"Bugroff",
		"C-UDA-1.0",
		"CAL-1.0",
		"CAL-1.0-Combined-Work-Exception",
		"CAPEC-tou",
		"CATOSL-1.1",
		"CC-BY-1.0",
		"CC-BY-2.0",
		"CC-BY-2.5",
		"CC-BY-2.5-AU",
		"CC-BY-3.0",
		"CC-BY-3.0-AT",
		"CC-BY-3.0-AU",
		"CC-BY-3.0-DE",
		"CC-BY-3.0-IGO",
		"CC-BY-3.0-NL",
		"CC-BY-3.0-US",
		"CC-BY-4.0",
		"CC-BY-NC-1.0",
		"CC-BY-NC-2.0",
		"CC-BY-NC-2.5",
		"CC-BY-NC-3.0",
		"CC-BY-NC-3.0-DE",
		"CC-BY-NC-3.0-IGO",
		"CC-BY-NC-4.0",
		"CC-BY-NC-ND-1.0",
		"CC-BY-NC-ND-2.0",
		"CC-BY-NC-ND-2.5",
		"CC-BY-NC-ND-3.0",
		"CC-BY-NC-ND-3.0-DE",
		"CC-BY-NC-ND-3.0-IGO",
		"CC-BY-NC-ND-4.0",
		"CC-BY-NC-SA-1.0",
		"CC-BY-NC-SA-2.0",
		"CC-BY-NC-SA-2.0-DE",
		"CC-BY-NC-SA-2.0-FR",
		"CC-BY-NC-SA-2.0-UK",
		"CC-BY-NC-SA-2.5",
		"CC-BY-NC-SA-3.0",
		"CC-BY-NC-SA-3.0-DE",
		"CC-BY-NC-SA-3.0-IGO",
		"CC-BY-NC-SA-4.0",
		"CC-BY-ND-1.0",
		"CC-BY-ND-2.0",
		"CC-BY-ND-2.5",
		"CC-BY-ND-3.0",
		"CC-BY-ND-3.0-DE",
		"CC-BY-ND-4.0",
		"CC-BY-SA-1.0",
		"CC-BY-SA-2.0",
		"CC-BY-SA-2.0-UK",
		"CC-BY-SA-2.1-JP",
		"CC-BY-SA-2.5",
		"CC-BY-SA-3.0",
		"CC-BY-SA-3.0-AT",
		"CC-BY-SA-3.0-DE",
		"CC-BY-SA-3.0-IGO",
		"CC-BY-SA-4.0",
		"CC-PDDC",
		"CC-PDM-1.0",
		"CC-SA-1.0",
		"CC0-1.0",
		"CDDL-1.0",
		"CDDL-1.1",
		"CDL-1.0",
		"CDLA-Permissive-1.0",
		"CDLA-Permissive-2.0",
		"CDLA-Sharing-1.0",
		"CECILL-1.0",
		"CECILL-1.1",
		"CECILL-2.0",
		"CECILL-2.1",
		"CECILL-B",
		"CECILL-C",
		"CERN-OHL-1.1",
		"CERN-OHL-1.2",
		"CERN-OHL-P-2.0",
		"CERN-OHL-S-2.0",
		"CERN-OHL-W-2.0",
		"CFITSIO",
		"CMU-Mach",
		"CMU-Mach-nodoc",
		"CNRI-Jython",
		"CNRI-Python",
		"CNRI-Python-GPL-Compatible",
		"COIL-1.0",
		"CPAL-1.0",
		"CPL-1.0",
		"CPOL-1.02",
		"CUA-OPL-1.0",
		"Caldera",
		"Caldera-no-preamble",
		"Catharon",
		"ClArtistic",
		"Clips",
		"Community-Spec-1.0",
		"Condor-1.1",
		"Cornell-Lossless-JPEG",
		"Cronyx",
		"Crossword",
		"CryptoSwift",
		"CrystalStacker",
		"Cube",
		"D-FSL-1.0",
		"DEC-3-Clause",
		"DL-DE-BY-2.0",
		"DL-DE-ZERO-2.0",
		"DOC",
		"DRL-1.0",
		"DRL-1.1",
		"DSDP",
		"DocBook-DTD",
		"DocBook-Schema",
		"DocBook-Stylesheet",
		"DocBook-XML",
		"Dotseqn",
		"ECL-1.0",
		"ECL-2.0",
		"EFL-1.0",
		"EFL-2.0",
		"EPICS",
		"EPL-1.0",
		"EPL-2.0",
		"ESA-PL-permissive-2.4",
		"ESA-PL-strong-copyleft-2.4",
		"ESA-PL-weak-copyleft-2.4",
		"EUDatagrid",
		"EUPL-1.0",
		"EUPL-1.1",
		"EUPL-1.2",
		"Elastic-2.0",
		"Entessa",
		"ErlPL-1.1",
		"Eurosym",
		"FBM",
		"FDK-AAC",
		"FDK-MPEG-H",
		"FSFAP",
		"FSFAP-no-warranty-disclaimer",
		"FSFUL",
		"FSFULLR",
		"FSFULLRSD",
		"FSFULLRWD",
		"FSL-1.1-ALv2",
		"FSL-1.1-MIT",
		"FTL",
		"Fair",
		"Ferguson-Twofish",
		"Frameworx-1.0",
		"FreeBSD-DOC",
		"FreeImage",
		"Furuseth",
		"GCR-docs",
		"GD",
		"GFDL-1.1-invariants-only",
		"GFDL-1.1-invariants-or-later",
		"GFDL-1.1-no-invariants-only",
		"GFDL-1.1-no-invariants-or-later",
		"GFDL-1.1-only",
		"GFDL-1.1-or-later",
		"GFDL-1.2-invariants-only",
		"GFDL-1.2-invariants-or-later",
		"GFDL-1.2-no-invariants-only",
		"GFDL-1.2-no-invariants-or-later",
		"GFDL-1.2-only",
		"GFDL-1.2-or-later",
		"GFDL-1.3-invariants-only",
		"GFDL-1.3-invariants-or-later",
		"GFDL-1.3-no-invariants-only",
		"GFDL-1.3-no-invariants-or-later",
		"GFDL-1.3-only",
		"GFDL-1.3-or-later",
		"GL2PS",
		"GLWTPL",
		"GPL-1.0-only",
		"GPL-1.0-or-later",
		"GPL-2.0-only",
		"GPL-2.0-or-later",
		"GPL-3.0-only",
		"GPL-3.0-or-later",
		"Game-Programming-Gems",
		"Giftware",
		"Glide",
		"Glulxe",
		"Graphics-Gems",
		"Gutmann",
		"HDF5",
		"HIDAPI",
		"HP-1986",
		"HP-1989",
		"HPND",
		"HPND-DEC",
		"HPND-Fenneberg-Livingston",
		"HPND-INRIA-IMAG",
		"HPND-Intel",
		"HPND-Kevlin-Henney",
		"HPND-MIT-disclaimer",
		"HPND-Markus-Kuhn",
		"HPND-Netrek",
		"HPND-Pbmplus",
		"HPND-SMC",
		"HPND-UC",
		"HPND-UC-export-US",
		"HPND-doc",
		"HPND-doc-sell",
		"HPND-export-US",
		"HPND-export-US-acknowledgement",
		"HPND-export-US-modify",
		"HPND-export2-US",
		"HPND-merchantability-variant",
		"HPND-sell-MIT-disclaimer-xserver",
		"HPND-sell-regexpr",
		"HPND-sell-variant",
		"HPND-sell-variant-MIT-disclaimer",
		"HPND-sell-variant-MIT-disclaimer-rev",
		"HPND-sell-variant-critical-systems",
		"HTMLTIDY",
		"HaskellReport",
		"Hippocratic-2.1",
		"Hippocratic-3.0-core",
		"IBM-pibs",
		"ICU",
		"IEC-Code-Components-EULA",
		"IJG",
		"IJG-short",
		"IPA",
		"IPL-1.0",
		"ISC",
		"ISC-Veillard",
		"ISO-permission",
		"ImageMagick",
		"Imlib2",
		"Info-ZIP",
		"Informatica",
		"Inner-Net-2.0",
		"InnoSetup",
		"Intel",
		"Intel-ACPI",
		"Interbase-1.0",
		"JPL-image",
		"JPNIC",
		"JSON",
		"Jam",
		"JasPer-2.0",
		"Kastrup",
		"Kazlib",
		"Knuth-CTAN",
		"LAL-1.2",
		"LAL-1.3",
		"LGPL-2.0-only",
		"LGPL-2.0-or-later",
		"LGPL-2.1-only",
		"LGPL-2.1-or-later",
		"LGPL-3.0-only",
		"LGPL-3.0-or-later",
		"LGPLLR",
		"LOOP",
		"LPD-document",
		"LPL-1.0",
		"LPL-1.02",
		"LPPL-1.0",
		"LPPL-1.1",
		"LPPL-1.2",
		"LPPL-1.3a",
		"LPPL-1.3c",
		"LZMA-SDK-9.11-to-9.20",
		"LZMA-SDK-9.22",
		"Latex2e",
		"Latex2e-translated-notice",
		"Leptonica",
		"LiLiQ-P-1.1",
		"LiLiQ-R-1.1",
		"LiLiQ-Rplus-1.1",
		"Libpng",
		"Linux-OpenIB",
		"Linux-man-pages-1-para",
		"Linux-man-pages-copyleft",
		"Linux-man-pages-copyleft-2-para",
		"Linux-man-pages-copyleft-var",
		"Lucida-Bitmap-Fonts",
		"MIPS",
		"MIT",
		"MIT-0",
		"MIT-CMU",
		"MIT-Click",
		"MIT-Festival",
		"MIT-Khronos-old",
		"MIT-Modern-Variant",
		"MIT-STK",
		"MIT-Wu",
		"MIT-advertising",
		"MIT-enna",
		"MIT-feh",
		"MIT-open-group",
		"MIT-testregex",
		"MITNFA",
		"MMIXware",
		"MMPL-1.0.1",
		"MPEG-SSG",
		"MPL-1.0",
		"MPL-1.1",
		"MPL-2.0",
		"MPL-2.0-no-copyleft-exception",
		"MS-LPL",
		"MS-PL",
		"MS-RL",
		"MTLL",
		"MVT-1.1",
		"Mackerras-3-Clause",
		"Mackerras-3-Clause-acknowledgment",
		"MakeIndex",
		"Martin-Birgmeier",
		"McPhee-slideshow",
		"Minpack",
		"MirOS",
		"Motosoto",
		"MulanPSL-1.0",
		"MulanPSL-2.0",
		"Multics",
		"Mup",
		"NAIST-2003",
		"NASA-1.3",
		"NBPL-1.0",
		"NCBI-PD",
		"NCGL-UK-2.0",
		"NCL",
		"NCSA",
		"NGPL",
		"NICTA-1.0",
		"NIST-PD",
		"NIST-PD-TNT",
		"NIST-PD-fallback",
		"NIST-Software",
		"NLOD-1.0",
		"NLOD-2.0",
		"NLPL",
		"NOSL",
		"NPL-1.0",
		"NPL-1.1",
		"NPOSL-3.0",
		"NRL",
		"NTIA-PD",
		"NTP",
		"NTP-0",
		"Naumen",
		"NetCDF",
		"Newsletr",
		"Nokia",
		"Noweb",
		"O-UDA-1.0",
		"OAR",
		"OCCT-PL",
		"OCLC-2.0",
		"ODC-By-1.0",
		"ODbL-1.0",
		"OFFIS",
		"OFL-1.0",
		"OFL-1.0-RFN",
		"OFL-1.0-no-RFN",
		"OFL-1.1",
		"OFL-1.1-RFN",
		"OFL-1.1-no-RFN",
		"OGC-1.0",
		"OGDL-Taiwan-1.0",
		"OGL-Canada-2.0",
		"OGL-UK-1.0",
		"OGL-UK-2.0",
		"OGL-UK-3.0",
		"OGTSL",
		"OLDAP-1.1",
		"OLDAP-1.2",
		"OLDAP-1.3",
		"OLDAP-1.4",
		"OLDAP-2.0",
		"OLDAP-2.0.1",
		"OLDAP-2.1",
		"OLDAP-2.2",
		"OLDAP-2.2.1",
		"OLDAP-2.2.2",
		"OLDAP-2.3",
		"OLDAP-2.4",
		"OLDAP-2.5",
		"OLDAP-2.6",
		"OLDAP-2.7",
		"OLDAP-2.8",
		"OLFL-1.3",
		"OML",
		"OPL-1.0",
		"OPL-UK-3.0",
		"OPUBL-1.0",
		"OSC-1.0",
		"OSET-PL-2.1",
		"OSL-1.0",
		"OSL-1.1",
		"OSL-2.0",
		"OSL-2.1",
		"OSL-3.0",
		"OSSP",
		"OpenMDW-1.0",
		"OpenPBS-2.3",
		"OpenSSL",
		"OpenSSL-standalone",
		"OpenVision",
		"PADL",
		"PDDL-1.0",
		"PHP-3.0",
		"PHP-3.01",
		"PPL",
		"PSF-2.0",
		"ParaType-Free-Font-1.3",
		"Parity-6.0.0",
		"Parity-7.0.0",
		"Pixar",
		"Plexus",
		"PolyForm-Noncommercial-1.0.0",
		"PolyForm-Small-Business-1.0.0",
		"PostgreSQL",
		"Python-2.0",
		"Python-2.0.1",
		"QPL-1.0",
		"QPL-1.0-INRIA-2004",
		"Qhull",
		"RHeCos-1.1",
		"RPL-1.1",
		"RPL-1.5",
		"RPSL-1.0",
		"RSA-MD",
		"RSCPL",
		"Rdisc",
		"Ruby",
		"Ruby-pty",
		"SAX-PD",
		"SAX-PD-2.0",
		"SCEA",
		"SGI-B-1.0",
		"SGI-B-1.1",
		"SGI-B-2.0",
		"SGI-OpenGL",
		"SGMLUG-PM",
		"SGP4",
		"SHL-0.5",
		"SHL-0.51",
		"SISSL",
		"SISSL-1.2",
		"SL",
		"SMAIL-GPL",
		"SMLNJ",
		"SMPPL",
		"SNIA",
		"SOFA",
		"SPL-1.0",
		"SSH-OpenSSH",
		"SSH-short",
		"SSLeay-standalone",
		"SSPL-1.0",
		"SUL-1.0",
		"SWL",
		"Saxpath",
		"SchemeReport",
		"Sendmail",
		"Sendmail-8.23",
		"Sendmail-Open-Source-1.1",
		"SimPL-2.0",
		"Sleepycat",
		"Soundex",
		"Spencer-86",
		"Spencer-94",
		"Spencer-99",
		"SugarCRM-1.1.3",
		"Sun-PPP",
		"Sun-PPP-2000",
		"SunPro",
		"Symlinks",
		"TAPR-OHL-1.0",
		"TCL",
		"TCP-wrappers",
		"TGPPL-1.0",
		"TMate",
		"TORQUE-1.1",
		"TOSL",
		"TPDL",
		"TPL-1.0",
		"TTWL",
		"TTYP0",
		"TU-Berlin-1.0",
		"TU-Berlin-2.0",
		"TekHVC",
		"TermReadKey",
		"ThirdEye",
		"TrustedQSL",
		"UCAR",
		"UCL-1.0",
		"UMich-Merit",
		"UPL-1.0",
		"URT-RLE",
		"Ubuntu-font-1.0",
		"UnRAR",
		"Unicode-3.0",
		"Unicode-DFS-2015",
		"Unicode-DFS-2016",
		"Unicode-TOU",
		"UnixCrypt",
		"Unlicense",
		"Unlicense-libtelnet",
		"Unlicense-libwhirlpool",
		"VOSTROM",
		"VSL-1.0",
		"Vim",
		"Vixie-Cron",
		"W3C",
		"W3C-19980720",
		"W3C-20150513",
		"WTFNMFPL",
		"WTFPL",
		"Watcom-1.0",
		"Widget-Workshop",
		"WordNet",
		"Wsuipa",
		"X11",
		"X11-distribute-modifications-variant",
		"X11-no-permit-persons",
		"X11-swapped",
		"XFree86-1.1",
		"XSkat",
		"Xdebug-1.03",
		"Xerox",
		"Xfig",
		"Xnet",
		"YPL-1.0",
		"YPL-1.1",
		"ZPL-1.1",
		"ZPL-2.0",
		"ZPL-2.1",
		"Zed",
		"Zeeff",
		"Zend-2.0",
		"Zimbra-1.3",
		"Zimbra-1.4",
		"Zlib",
		"any-OSI",
		"any-OSI-perl-modules",
		"atc-game",
		"bcrypt-Solar-Designer",
		"blessing",
		"bzip2-1.0.6",
		"check-cvs",
		"checkmk",
		"copyleft-next-0.3.0",
		"copyleft-next-0.3.1",
		"curl",
		"cve-tou",
		"diffmark",
		"dtoa",
		"dvipdfm",
		"eGenix",
		"etalab-2.0",
		"fwlw",
		"gSOAP-1.3b",
		"generic-xts",
		"gnuplot",
		"gtkbook",
		"hdparm",
		"hyphen-bulgarian",
		"iMatix",
		"jove",
		"libpng-1.6.35",
		"libpng-2.0",
		"libselinux-1.0",
		"libtiff",
		"libutil-David-Nugent",
		"lsof",
		"magaz",
		"mailprio",
		"man2html",
		"metamail",
		"mpi-permissive",
		"mpich2",
		"mplus",
		"ngrep",
		"pkgconf",
		"pnmstitch",
		"psfrag",
		"psutils",
		"python-ldap",
		"radvd",
		"snprintf",
		"softSurfer",
		"ssh-keyscan",
		"swrule",
		"threeparttable",
		"ulem",
		"w3m",
		"wwl",
		"xinetd",
		"xkeyboard-config-Zinoviev",
		"xlock",
		"xpp",
		"xzoom",
		"zlib-acknowledgement"
	];
}));

// node_modules/spdx-license-ids/deprecated.json
var require_deprecated = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = [
		"AGPL-1.0",
		"AGPL-3.0",
		"BSD-2-Clause-FreeBSD",
		"BSD-2-Clause-NetBSD",
		"GFDL-1.1",
		"GFDL-1.2",
		"GFDL-1.3",
		"GPL-1.0",
		"GPL-2.0",
		"GPL-2.0-with-GCC-exception",
		"GPL-2.0-with-autoconf-exception",
		"GPL-2.0-with-bison-exception",
		"GPL-2.0-with-classpath-exception",
		"GPL-2.0-with-font-exception",
		"GPL-3.0",
		"GPL-3.0-with-GCC-exception",
		"GPL-3.0-with-autoconf-exception",
		"LGPL-2.0",
		"LGPL-2.1",
		"LGPL-3.0",
		"Net-SNMP",
		"Nunit",
		"StandardML-NJ",
		"bzip2-1.0.5",
		"eCos-2.0",
		"wxWindows"
	];
}));

// node_modules/spdx-exceptions/index.json
var require_spdx_exceptions = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = [
		"389-exception",
		"Asterisk-exception",
		"Autoconf-exception-2.0",
		"Autoconf-exception-3.0",
		"Autoconf-exception-generic",
		"Autoconf-exception-generic-3.0",
		"Autoconf-exception-macro",
		"Bison-exception-1.24",
		"Bison-exception-2.2",
		"Bootloader-exception",
		"Classpath-exception-2.0",
		"CLISP-exception-2.0",
		"cryptsetup-OpenSSL-exception",
		"DigiRule-FOSS-exception",
		"eCos-exception-2.0",
		"Fawkes-Runtime-exception",
		"FLTK-exception",
		"fmt-exception",
		"Font-exception-2.0",
		"freertos-exception-2.0",
		"GCC-exception-2.0",
		"GCC-exception-2.0-note",
		"GCC-exception-3.1",
		"Gmsh-exception",
		"GNAT-exception",
		"GNOME-examples-exception",
		"GNU-compiler-exception",
		"gnu-javamail-exception",
		"GPL-3.0-interface-exception",
		"GPL-3.0-linking-exception",
		"GPL-3.0-linking-source-exception",
		"GPL-CC-1.0",
		"GStreamer-exception-2005",
		"GStreamer-exception-2008",
		"i2p-gpl-java-exception",
		"KiCad-libraries-exception",
		"LGPL-3.0-linking-exception",
		"libpri-OpenH323-exception",
		"Libtool-exception",
		"Linux-syscall-note",
		"LLGPL",
		"LLVM-exception",
		"LZMA-exception",
		"mif-exception",
		"OCaml-LGPL-linking-exception",
		"OCCT-exception-1.0",
		"OpenJDK-assembly-exception-1.0",
		"openvpn-openssl-exception",
		"PS-or-PDF-font-exception-20170817",
		"QPL-1.0-INRIA-2004-exception",
		"Qt-GPL-exception-1.0",
		"Qt-LGPL-exception-1.1",
		"Qwt-exception-1.0",
		"SANE-exception",
		"SHL-2.0",
		"SHL-2.1",
		"stunnel-exception",
		"SWI-exception",
		"Swift-exception",
		"Texinfo-exception",
		"u-boot-exception-2.0",
		"UBDL-exception",
		"Universal-FOSS-exception-1.0",
		"vsftpd-openssl-exception",
		"WxWindows-exception-3.1",
		"x11vnc-openssl-exception"
	];
}));

// node_modules/spdx-expression-parse/scan.js
var require_scan = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var licenses = [].concat(require_spdx_license_ids()).concat(require_deprecated());
	var exceptions = require_spdx_exceptions();
	module.exports = function(source) {
		var index = 0;
		function hasMore() {
			return index < source.length;
		}
		function read(value) {
			if (value instanceof RegExp) {
				var match = source.slice(index).match(value);
				if (match) {
					index += match[0].length;
					return match[0];
				}
			} else if (source.indexOf(value, index) === index) {
				index += value.length;
				return value;
			}
		}
		function skipWhitespace() {
			read(/[ ]*/);
		}
		function operator() {
			var string;
			var possibilities = [
				/^WITH/i,
				/^AND/i,
				/^OR/i,
				"(",
				")",
				":",
				"+"
			];
			for (var i = 0; i < possibilities.length; i++) {
				string = read(possibilities[i]);
				if (string) break;
			}
			if (string === "+" && index > 1 && source[index - 2] === " ") throw new Error("Space before `+`");
			return string && {
				type: "OPERATOR",
				string: string.toUpperCase()
			};
		}
		function idstring() {
			return read(/[A-Za-z0-9-.]+/);
		}
		function expectIdstring() {
			var string = idstring();
			if (!string) throw new Error("Expected idstring at offset " + index);
			return string;
		}
		function documentRef() {
			if (read("DocumentRef-")) return {
				type: "DOCUMENTREF",
				string: expectIdstring()
			};
		}
		function licenseRef() {
			if (read("LicenseRef-")) return {
				type: "LICENSEREF",
				string: expectIdstring()
			};
		}
		function identifier() {
			var begin = index;
			var string = idstring();
			if (licenses.indexOf(string) !== -1) return {
				type: "LICENSE",
				string
			};
			else if (exceptions.indexOf(string) !== -1) return {
				type: "EXCEPTION",
				string
			};
			index = begin;
		}
		function parseToken() {
			return operator() || documentRef() || licenseRef() || identifier();
		}
		var tokens = [];
		while (hasMore()) {
			skipWhitespace();
			if (!hasMore()) break;
			var token = parseToken();
			if (!token) throw new Error("Unexpected `" + source[index] + "` at offset " + index);
			tokens.push(token);
		}
		return tokens;
	};
}));

// node_modules/spdx-expression-parse/parse.js
var require_parse$1 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = function(tokens) {
		var index = 0;
		function hasMore() {
			return index < tokens.length;
		}
		function token() {
			return hasMore() ? tokens[index] : null;
		}
		function next() {
			if (!hasMore()) throw new Error();
			index++;
		}
		function parseOperator(operator) {
			var t = token();
			if (t && t.type === "OPERATOR" && operator === t.string) {
				next();
				return t.string;
			}
		}
		function parseWith() {
			if (parseOperator("WITH")) {
				var t = token();
				if (t && t.type === "EXCEPTION") {
					next();
					return t.string;
				}
				throw new Error("Expected exception after `WITH`");
			}
		}
		function parseLicenseRef() {
			var begin = index;
			var string = "";
			var t = token();
			if (t.type === "DOCUMENTREF") {
				next();
				string += "DocumentRef-" + t.string + ":";
				if (!parseOperator(":")) throw new Error("Expected `:` after `DocumentRef-...`");
			}
			t = token();
			if (t === null) throw new Error("Unexpected end of input");
			if (t.type === "LICENSEREF") {
				next();
				string += "LicenseRef-" + t.string;
				var node = { license: string };
				var exception = parseWith();
				if (exception) node.exception = exception;
				return node;
			}
			index = begin;
		}
		function parseLicense() {
			var t = token();
			if (t && t.type === "LICENSE") {
				next();
				var node = { license: t.string };
				if (parseOperator("+")) node.plus = true;
				var exception = parseWith();
				if (exception) node.exception = exception;
				return node;
			}
		}
		function parseParenthesizedExpression() {
			if (!parseOperator("(")) return;
			var expr = parseExpression();
			if (!parseOperator(")")) throw new Error("Expected `)`");
			return expr;
		}
		function parseAtom() {
			return parseParenthesizedExpression() || parseLicenseRef() || parseLicense();
		}
		function makeBinaryOpParser(operator, nextParser) {
			return function parseBinaryOp() {
				var left = nextParser();
				if (!left) return;
				if (!parseOperator(operator)) return left;
				var right = parseBinaryOp();
				if (!right) throw new Error("Expected expression");
				return {
					left,
					conjunction: operator.toLowerCase(),
					right
				};
			};
		}
		var parseExpression = makeBinaryOpParser("OR", makeBinaryOpParser("AND", parseAtom));
		var node = parseExpression();
		if (!node || hasMore()) throw new Error("Syntax error");
		return node;
	};
}));

// node_modules/spdx-expression-parse/index.js
var require_spdx_expression_parse = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var scan = require_scan();
	var parse = require_parse$1();
	module.exports = function(source) {
		return parse(scan(source));
	};
}));

// src/evidence/npm-registry.ts
var import_spdx_expression_parse = /* @__PURE__ */ __toESM(require_spdx_expression_parse(), 1);

// src/evidence/upstream-read.ts
function upstreamText(value) {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 1024 && !/[\p{Cc}\p{Cs}]/u.test(value);
}

// src/evidence/policy-signals-evidence.ts
function observe(read) {
	try {
		return {
			kind: "known",
			value: read()
		};
	} catch (error) {
		return {
			kind: "unchecked",
			reason: error instanceof AdvisoryFailure ? error.reason : "malformed"
		};
	}
}

// node_modules/smol-toml/dist/error.js
/*!
* Copyright (c) Squirrel Chat et al., All rights reserved.
* SPDX-License-Identifier: BSD-3-Clause
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*
* 1. Redistributions of source code must retain the above copyright notice, this
*    list of conditions and the following disclaimer.
* 2. Redistributions in binary form must reproduce the above copyright notice,
*    this list of conditions and the following disclaimer in the
*    documentation and/or other materials provided with the distribution.
* 3. Neither the name of the copyright holder nor the names of its contributors
*    may be used to endorse or promote products derived from this software without
*    specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
* ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
* WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
* DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
* FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
* DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
* SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
* CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
* OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
* OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
function getLineColFromPtr(string, ptr) {
	let lines = string.slice(0, ptr).split(/\r?\n/);
	return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
	let lines = string.split(/\r?\n/);
	let codeblock = "";
	let numberLen = (Math.log10(line + 1) | 0) + 1;
	for (let i = line - 1; i <= line + 1; i++) {
		let l = lines[i - 1];
		if (!l) continue;
		codeblock += i.toString().padEnd(numberLen, " ");
		codeblock += ":  ";
		codeblock += l;
		codeblock += "\n";
		if (i === line) {
			codeblock += " ".repeat(numberLen + column + 2);
			codeblock += "^\n";
		}
	}
	return codeblock;
}
var TomlError = class TomlError extends Error {
	line;
	column;
	codeblock;
	constructor(message, options) {
		const [line, column] = getLineColFromPtr(options.toml, options.ptr);
		const codeblock = makeCodeBlock(options.toml, line, column);
		super(`Invalid TOML document: ${message}\n\n${codeblock}`, options);
		this.line = line;
		this.column = column;
		this.codeblock = codeblock;
	}
	/** @internal */
	static x(message, ctx, ptr) {
		throw new TomlError(message, {
			toml: ctx.s,
			ptr: ptr ?? ctx.p
		});
	}
};

// node_modules/smol-toml/dist/primitive.js
/*!
* Copyright (c) Squirrel Chat et al., All rights reserved.
* SPDX-License-Identifier: BSD-3-Clause
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*
* 1. Redistributions of source code must retain the above copyright notice, this
*    list of conditions and the following disclaimer.
* 2. Redistributions in binary form must reproduce the above copyright notice,
*    this list of conditions and the following disclaimer in the
*    documentation and/or other materials provided with the distribution.
* 3. Neither the name of the copyright holder nor the names of its contributors
*    may be used to endorse or promote products derived from this software without
*    specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
* ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
* WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
* DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
* FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
* DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
* SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
* CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
* OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
* OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
/** @internal */
function parseString(ctx) {
	let startPtr = ctx.p;
	let c = ctx.s.charCodeAt(ctx.p++);
	let first = c;
	let isLiteral = c === 39;
	let isMultiline = c === ctx.s.charCodeAt(ctx.p) && c === ctx.s.charCodeAt(ctx.p + 1);
	if (isMultiline) {
		if ((c = ctx.s.charCodeAt(ctx.p += 2)) === 10) ctx.p++;
		else if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10) ctx.p += 2;
	}
	let parsed = "";
	let sliceStart = ctx.p;
	let state = 0;
	for (; ctx.p < ctx.s.length; ctx.p++) {
		c = ctx.s.charCodeAt(ctx.p);
		if (isMultiline && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)) state = state && 3;
		else if (c < 32 && c !== 9 || c === 127) TomlError.x("control characters are not allowed in strings", ctx);
		else if ((!state || state === 3) && c === first && (!isMultiline || ctx.s.charCodeAt(ctx.p + 1) === first && ctx.s.charCodeAt(ctx.p + 2) === first)) {
			if (isMultiline) {
				if (ctx.s.charCodeAt(ctx.p + 3) === first) ctx.p++;
				if (ctx.s.charCodeAt(ctx.p + 3) === first) ctx.p++;
			}
			if (!state) {
				let s = ctx.s.slice(sliceStart, ctx.p);
				parsed = parsed ? parsed + s : s;
			}
			ctx.p += isMultiline ? 3 : 1;
			return parsed;
		} else if (!state) {
			if (!isLiteral && c === 92) {
				parsed += ctx.s.slice(sliceStart, sliceStart = ctx.p);
				state = 1;
			}
		} else if (state === 1) {
			if (c === 120 || c === 117 || c === 85) {
				let errPtr = ctx.p++ - 1;
				let value = 0;
				let len = c === 120 ? 2 : c === 117 ? 4 : 8;
				for (let j = 0; j < len; j++, ctx.p++) {
					let hex = ctx.s.charCodeAt(ctx.p);
					let digit = hex >= 48 && hex <= 57 ? hex - 48 : hex >= 65 && hex <= 70 ? hex - 65 + 10 : hex >= 97 && hex <= 102 ? hex - 97 + 10 : -1;
					if (digit < 0) TomlError.x("invalid non-hex character in unicode escape", ctx);
					value = value << 4 | digit;
				}
				if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) TomlError.x("invalid unicode escape", ctx, errPtr);
				parsed += String.fromCodePoint(value);
				sliceStart = ctx.p--;
				state = 0;
			} else if (isMultiline && (c === 32 || c === 9)) state = 2;
			else {
				if (c === 98) parsed += "\b";
				else if (c === 116) parsed += "	";
				else if (c === 110) parsed += "\n";
				else if (c === 102) parsed += "\f";
				else if (c === 114) parsed += "\r";
				else if (c === 101) parsed += "\x1B";
				else if (c === 34) parsed += "\"";
				else if (c === 92) parsed += "\\";
				else TomlError.x("unrecognised escape sequence", ctx);
				sliceStart = ctx.p + 1;
				state = 0;
			}
		} else if (c !== 32 && c !== 9) {
			if (state === 2) TomlError.x("invalid escape: only line-ending whitespace may be escaped", ctx, sliceStart);
			state = !isLiteral && c === 92 ? 1 : 0;
			sliceStart = ctx.p;
		}
	}
	TomlError.x("unfinished string", ctx, startPtr);
}

// node_modules/smol-toml/dist/date.js
/*!
* Copyright (c) Squirrel Chat et al., All rights reserved.
* SPDX-License-Identifier: BSD-3-Clause
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*
* 1. Redistributions of source code must retain the above copyright notice, this
*    list of conditions and the following disclaimer.
* 2. Redistributions in binary form must reproduce the above copyright notice,
*    this list of conditions and the following disclaimer in the
*    documentation and/or other materials provided with the distribution.
* 3. Neither the name of the copyright holder nor the names of its contributors
*    may be used to endorse or promote products derived from this software without
*    specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
* ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
* WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
* DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
* FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
* DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
* SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
* CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
* OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
* OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
let DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[Tt ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|z|[-+]\d{2}:\d{2})?$/i;
var TomlDate = class TomlDate extends Date {
	#hasDate = false;
	#hasTime = false;
	#offset = null;
	constructor(date, fasttype, unsafeDelim) {
		let hasDate = true;
		let hasTime = true;
		let offset = "Z";
		let c;
		if (typeof date === "string") {
			if (fasttype) prep: {
				if (fasttype < 3) {
					if (+date.slice(11, 13) > 23) {
						date = "";
						break prep;
					}
					if (fasttype === 2) {
						offset = null;
						date += "Z";
					} else if ((c = date.charCodeAt(date.length - 1)) !== 90 && c !== 122) offset = date.slice(date.length - 6);
					if (unsafeDelim) date = date.slice(0, 10) + "T" + date.slice(11);
				} else if (fasttype === 4) date = +date.slice(0, 2) > 23 ? "" : `0000-01-01T${date}Z`;
				hasDate = fasttype !== 4;
				hasTime = fasttype !== 3;
			}
			else {
				let match = date.match(DATE_TIME_RE);
				if (match) {
					if (!match[1]) {
						hasDate = false;
						date = `0000-01-01T${date}`;
					}
					hasTime = !!match[2];
					hasTime && date[10] === " " && (date = date.replace(" ", "T"));
					if (match[2] && +match[2] > 23) date = "";
					else {
						offset = match[3] || null;
						if (!offset && hasTime) date += "Z";
					}
				} else date = "";
			}
		}
		super(date);
		if (!isNaN(this.getTime())) {
			this.#hasDate = hasDate;
			this.#hasTime = hasTime;
			this.#offset = offset;
		}
	}
	isDateTime() {
		return this.#hasDate && this.#hasTime;
	}
	isLocal() {
		return !this.#hasDate || !this.#hasTime || !this.#offset;
	}
	isDate() {
		return this.#hasDate && !this.#hasTime;
	}
	isTime() {
		return this.#hasTime && !this.#hasDate;
	}
	isValid() {
		return this.#hasDate || this.#hasTime;
	}
	toISOString() {
		let iso = super.toISOString();
		if (this.isDate()) return iso.slice(0, 10);
		if (this.isTime()) return iso.slice(11, 23);
		if (this.#offset === null) return iso.slice(0, -1);
		if (this.#offset === "Z" || this.#offset === "z") return iso;
		let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
		offset = this.#offset[0] === "-" ? offset : -offset;
		return (/* @__PURE__ */ new Date(this.getTime() - offset * 6e4)).toISOString().slice(0, -1) + this.#offset;
	}
	static wrapAsOffsetDateTime(jsDate, offset = "Z") {
		let date = new TomlDate(jsDate);
		date.#offset = offset;
		return date;
	}
	static wrapAsLocalDateTime(jsDate) {
		let date = new TomlDate(jsDate);
		date.#offset = null;
		return date;
	}
	static wrapAsLocalDate(jsDate) {
		let date = new TomlDate(jsDate);
		date.#hasTime = false;
		date.#offset = null;
		return date;
	}
	static wrapAsLocalTime(jsDate) {
		let date = new TomlDate(jsDate);
		date.#hasDate = false;
		date.#offset = null;
		return date;
	}
};

// node_modules/smol-toml/dist/extract.js
/*!
* Copyright (c) Squirrel Chat et al., All rights reserved.
* SPDX-License-Identifier: BSD-3-Clause
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*
* 1. Redistributions of source code must retain the above copyright notice, this
*    list of conditions and the following disclaimer.
* 2. Redistributions in binary form must reproduce the above copyright notice,
*    this list of conditions and the following disclaimer in the
*    documentation and/or other materials provided with the distribution.
* 3. Neither the name of the copyright holder nor the names of its contributors
*    may be used to endorse or promote products derived from this software without
*    specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
* ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
* WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
* DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
* FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
* DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
* SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
* CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
* OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
* OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
function isDigit(char, base = 10) {
	return base === 16 ? char > 47 && char < 58 || char > 64 && char < 71 || char > 96 && char < 103 : char > 47 && char < 48 + base;
}
function isEndOfValue(char, delim) {
	return char === 32 || char === 9 || char === 10 || char === 13 || delim && (char === delim || char === 44) || char === 35;
}
/** @internal */
function extractValue(ctx, end) {
	let errPtr = ctx.p;
	let c = ctx.s.charCodeAt(ctx.p);
	if (c === 91 || c === 123) {
		ctx.d-- || TomlError.x("document contains excessively nested structures. aborting.", ctx);
		let value = c === 91 ? parseArray(ctx) : parseInlineTable(ctx);
		ctx.d++;
		return value;
	}
	if (c === 34 || c === 39) return parseString(ctx);
	if (c === 116) {
		if (ctx.s.charCodeAt(++ctx.p) !== 114 || ctx.s.charCodeAt(++ctx.p) !== 117 || ctx.s.charCodeAt(++ctx.p) !== 101) TomlError.x("invalid value", ctx, errPtr);
		return ctx.p++, true;
	}
	if (c === 102) {
		if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 108 || ctx.s.charCodeAt(++ctx.p) !== 115 || ctx.s.charCodeAt(++ctx.p) !== 101) TomlError.x("invalid value", ctx, errPtr);
		return ctx.p++, false;
	}
	if (c === 43 || c === 45) return parseNumber(ctx, ctx.p, ctx.s.charCodeAt(++ctx.p), 44 - c, end);
	if (ctx.s.charCodeAt(ctx.p + 4) === 45 && ctx.s.charCodeAt(ctx.p + 7) === 45) return parseDate(ctx, c, end);
	if (ctx.s.charCodeAt(ctx.p + 2) === 58) return parseTime(ctx, c, end);
	return parseNumber(ctx, ctx.p, c, 0, end);
}
function parseNumber(ctx, startPtr, startChr, sign, endChr) {
	let c = startChr;
	let state = 0;
	let hasUnderscores = false;
	if (c === 105) {
		if (ctx.s.charCodeAt(++ctx.p) !== 110 || ctx.s.charCodeAt(++ctx.p) !== 102) TomlError.x("invalid value", ctx, startPtr);
		return ctx.p++, (sign || 1) / 0;
	}
	if (c === 110) {
		if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 110) TomlError.x("invalid value", ctx, startPtr);
		return ctx.p++, NaN;
	}
	if (c === 48) {
		if (++ctx.p >= ctx.s.length || isEndOfValue(c = ctx.s.charCodeAt(ctx.p), endChr)) return ctx.bi === true ? 0n : 0;
		if (!sign) {
			if (c === 120) return parseIntegerBaseN(ctx, startPtr, 16, endChr);
			else if (c === 98) return parseIntegerBaseN(ctx, startPtr, 2, endChr);
			else if (c === 111) return parseIntegerBaseN(ctx, startPtr, 8, endChr);
		}
		if (c === 46) state = 2;
		else if (c === 101 || c === 69) state = 4;
		else TomlError.x("illegal leading zero", ctx, startPtr);
	} else if (!isDigit(c)) TomlError.x("invalid value", ctx, startPtr);
	while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
		if (!state) state = 1;
		if (c === 95) {
			if (!(state & 1)) TomlError.x("illegal underscore", ctx);
			state += 11;
			hasUnderscores = true;
		} else if (state === 1 && c === 46) state = 2;
		else if ((state === 1 || state === 3) && (c === 101 || c === 69)) state = 4;
		else if (state === 4 && (c === 43 || c === 45)) state = 6;
		else if (!isDigit(c)) TomlError.x(`illegal character in numeric literal`, ctx);
		else if (state > 9) state -= 11;
		else if (!(state & 1)) state++;
	}
	if (!state) {
		let val = (startChr - 48) * (sign || 1);
		return ctx.bi === true ? BigInt(val) : val;
	}
	if (!(state & 1)) TomlError.x("unfinished numeric value", ctx, startPtr);
	let str = ctx.s.slice(startPtr, ctx.p);
	if (hasUnderscores) str = str.replaceAll("_", "");
	return state > 1 ? parseFloat(str) : parseInteger(ctx, str, 10, startPtr);
}
function parseIntegerBaseN(ctx, startPtr, base, endChr) {
	let c, underscore = 1;
	while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) if (c === 95) {
		if (underscore & 1) TomlError.x("illegal underscore", ctx);
		underscore = 3;
	} else if (!isDigit(c, base)) TomlError.x(`illegal character in numeric literal`, ctx);
	else if (underscore & 1) underscore--;
	if (underscore & 1) TomlError.x("unfinished numeric value", ctx);
	let str = ctx.s.slice(startPtr + 2, ctx.p);
	if (underscore) str = str.replaceAll("_", "");
	return parseInteger(ctx, str, base, startPtr);
}
function parseInteger(ctx, str, base, startPtr) {
	if (ctx.bi !== true) int: {
		let val = parseInt(str, base);
		if (!Number.isSafeInteger(val)) {
			if (ctx.bi) break int;
			TomlError.x("integer value cannot be represented losslessly", ctx, startPtr);
		}
		return val;
	}
	return base === 10 ? BigInt(str) : BigInt((base === 2 ? "0b" : base === 8 ? "0o" : "0x") + str);
}
function parseDate(ctx, c, endChr) {
	let startPtr = ctx.p++, unsafeSeparator;
	if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++))) return parseNumber(ctx, ctx.p = startPtr, c, 0, endChr);
	ctx.p += 5;
	if (!isDigit(ctx.s.charCodeAt(ctx.p++))) TomlError.x("invalid date-time: date part is malformed", ctx, startPtr);
	if (ctx.p >= ctx.s.length || ((c = ctx.s.charCodeAt(ctx.p)) !== 32 || (unsafeSeparator = true, !isDigit(ctx.s.charCodeAt(ctx.p + 1)))) && c !== 84 && c !== 116) return readDate(ctx, ctx.s.slice(startPtr, ctx.p), 3, false, startPtr);
	if (ctx.s.charCodeAt(ctx.p += 3) !== 58) TomlError.x("invalid date-time: time part is malformed", ctx, startPtr);
	if (ctx.s.charCodeAt(ctx.p += 3) === 58) ctx.p += 3;
	if (ctx.s.charCodeAt(ctx.p) === 46) while (isDigit(ctx.s.charCodeAt(++ctx.p)));
	if (c = ctx.s.charCodeAt(ctx.p)) {
		if (c === 90 || c === 122) return readDate(ctx, ctx.s.slice(startPtr, ++ctx.p), 1, unsafeSeparator, startPtr, "[+00:00]");
		if (c === 43 || c === 45) return readDate(ctx, ctx.s.slice(startPtr, ctx.p += 6), 1, unsafeSeparator, startPtr, !ctx.ld && "[" + ctx.s.slice(ctx.p - 6, ctx.p) + "]");
	}
	return readDate(ctx, ctx.s.slice(startPtr, ctx.p), 2, unsafeSeparator, startPtr);
}
function parseTime(ctx, c, endChr) {
	let start = ctx.p;
	if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(++ctx.p))) return parseNumber(ctx, --ctx.p, c, 0, endChr);
	if (ctx.s.charCodeAt(ctx.p += 4) === 58) ctx.p += 3;
	if (ctx.s.charCodeAt(ctx.p) === 46) while (isDigit(ctx.s.charCodeAt(++ctx.p)));
	return readDate(ctx, ctx.s.slice(start, ctx.p), 4, false, start);
}
function readDate(ctx, str, type, unsafeDelim, errPtr, temporalSuffix) {
	if (ctx.ld) {
		let date = new TomlDate(str, type, unsafeDelim);
		if (!date.isValid()) TomlError.x("invalid date", ctx, errPtr);
		return date;
	}
	try {
		if (temporalSuffix) str += temporalSuffix;
		switch (type) {
			case 1: return Temporal.ZonedDateTime.from(str);
			case 2: return Temporal.PlainDateTime.from(str);
			case 3: return Temporal.PlainDate.from(str);
			case 4: return Temporal.PlainTime.from(str);
		}
	} catch (e) {
		TomlError.x(e instanceof Error ? e.message : "" + e, ctx, errPtr);
	}
}

// node_modules/smol-toml/dist/util.js
/*!
* Copyright (c) Squirrel Chat et al., All rights reserved.
* SPDX-License-Identifier: BSD-3-Clause
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*
* 1. Redistributions of source code must retain the above copyright notice, this
*    list of conditions and the following disclaimer.
* 2. Redistributions in binary form must reproduce the above copyright notice,
*    this list of conditions and the following disclaimer in the
*    documentation and/or other materials provided with the distribution.
* 3. Neither the name of the copyright holder nor the names of its contributors
*    may be used to endorse or promote products derived from this software without
*    specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
* ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
* WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
* DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
* FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
* DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
* SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
* CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
* OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
* OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
/** @internal */
function skipComment(ctx) {
	for (; ctx.p < ctx.s.length; ctx.p++) {
		let c = ctx.s.charCodeAt(ctx.p);
		if (c === 10) break;
		if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10) {
			ctx.p++;
			break;
		}
		if (c < 32 && c !== 9 || c === 127) TomlError.x("control characters are not allowed in comments", ctx);
	}
}
/** @internal */
function skipVoid(ctx, banNewLines, banComments) {
	let c;
	while (ctx.p < ctx.s.length) {
		while (ctx.p < ctx.s.length && ((c = ctx.s.charCodeAt(ctx.p)) === 32 || c === 9 || !banNewLines && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10))) ctx.p++;
		if (banComments || c !== 35) break;
		skipComment(ctx);
	}
}

// node_modules/smol-toml/dist/struct.js
/*!
* Copyright (c) Squirrel Chat et al., All rights reserved.
* SPDX-License-Identifier: BSD-3-Clause
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*
* 1. Redistributions of source code must retain the above copyright notice, this
*    list of conditions and the following disclaimer.
* 2. Redistributions in binary form must reproduce the above copyright notice,
*    this list of conditions and the following disclaimer in the
*    documentation and/or other materials provided with the distribution.
* 3. Neither the name of the copyright holder nor the names of its contributors
*    may be used to endorse or promote products derived from this software without
*    specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
* ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
* WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
* DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
* FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
* DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
* SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
* CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
* OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
* OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
/** @internal */
function parseKey(ctx, end = 61) {
	let startPtr;
	let state = 0;
	let parsed = [];
	let sliceStart;
	let c = ctx.s.charCodeAt(startPtr = ctx.p);
	do
		if (c === end) {
			if (!state) TomlError.x("unexpected end of key", ctx);
			if (state === 1) parsed.push(ctx.s.slice(sliceStart, ctx.p));
			return ctx.p++, parsed;
		} else if (c === 46) {
			if (!state) TomlError.x("illegal empty bare key", ctx);
			if (state === 1) parsed.push(ctx.s.slice(sliceStart, ctx.p));
			state = 0;
		} else if (!state && (c === 34 || c === 39)) {
			if (c === ctx.s.charCodeAt(ctx.p + 1) && c === ctx.s.charCodeAt(ctx.p + 2)) TomlError.x("illegal quoted key: multiline strings are not allowed", ctx);
			parsed.push(parseString(ctx));
			state = 2;
			ctx.p--;
		} else if (c === 32 || c === 9) {
			if (state === 1) {
				parsed.push(ctx.s.slice(sliceStart, ctx.p));
				state = 2;
			}
		} else if (state === 2 || c < 48 && c !== 45 || c > 57 && c < 65 || c > 90 && c < 97 && c !== 95 || c > 122) TomlError.x("illegal character in key", ctx);
		else if (!state) {
			state = 1;
			sliceStart = ctx.p;
		}
	while (c = ctx.s.charCodeAt(++ctx.p));
	TomlError.x("incomplete key-value: cannot find end of key", ctx, startPtr);
}
/** @internal */
function parseInlineTable(ctx) {
	let startPtr = ctx.p++;
	let res = Object.create(null);
	let seen = /* @__PURE__ */ new Set();
	let c;
	while (ctx.p < ctx.s.length) {
		skipVoid(ctx);
		if ((c = ctx.s.charCodeAt(ctx.p)) === 125) {
			ctx.p++;
			return res;
		}
		let k;
		let t = res;
		let hasOwn = false;
		let errPtr = ctx.p;
		let key = parseKey(ctx);
		for (let i = 0; i < key.length; i++) {
			if (i) t = hasOwn ? t[k] : t[k] = Object.create(null);
			k = key[i];
			if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) TomlError.x("trying to redefine an already defined value", ctx, errPtr);
			let unsafe = k === "__proto__";
			if (ctx.uk && (unsafe || k === "constructor")) {
				t = ctx.uk !== 1 && TomlError.x("document contains an unsafe property", ctx, errPtr);
				break;
			}
			if (!hasOwn && unsafe) Object.defineProperty(t, k, {
				enumerable: true,
				configurable: true,
				writable: true
			});
		}
		if (hasOwn) TomlError.x("trying to redefine an already defined value", ctx, errPtr);
		skipVoid(ctx, true, true);
		let value = extractValue(ctx, 125);
		if (t && typeof (t[k] = value) === "object") seen.add(value);
		skipVoid(ctx);
		if ((c = ctx.s.charCodeAt(ctx.p++)) === 125) return res;
		if (c !== 44) TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
	}
	TomlError.x("unfinished table", ctx, startPtr);
}
/** @internal */
function parseArray(ctx) {
	let startPtr = ctx.p++;
	let res = [];
	let c;
	while (ctx.p < ctx.s.length) {
		skipVoid(ctx);
		if ((c = ctx.s.charCodeAt(ctx.p)) === 93) {
			ctx.p++;
			return res;
		}
		res.push(extractValue(ctx, 93));
		skipVoid(ctx);
		if ((c = ctx.s.charCodeAt(ctx.p++)) === 93) return res;
		if (c !== 44) TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
	}
	TomlError.x("unfinished array", ctx, startPtr);
}

// node_modules/smol-toml/dist/parse.js
/*!
* Copyright (c) Squirrel Chat et al., All rights reserved.
* SPDX-License-Identifier: BSD-3-Clause
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*
* 1. Redistributions of source code must retain the above copyright notice, this
*    list of conditions and the following disclaimer.
* 2. Redistributions in binary form must reproduce the above copyright notice,
*    this list of conditions and the following disclaimer in the
*    documentation and/or other materials provided with the distribution.
* 3. Neither the name of the copyright holder nor the names of its contributors
*    may be used to endorse or promote products derived from this software without
*    specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
* ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
* WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
* DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
* FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
* DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
* SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
* CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
* OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
* OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
function peekTable(ctx, key, table, meta, type) {
	let t = table;
	let m = meta;
	let k;
	let hasOwn = false;
	let state;
	for (let i = 0; i < key.length; i++) {
		if (i) {
			t = hasOwn ? t[k] : t[k] = Object.create(null);
			m = (state = m[k]).c;
			if (type === 0 && (state.t === 1 || state.t === 2)) return null;
			if (state.t === 2) {
				let l = t.length - 1;
				t = t[l];
				m = m[l].c;
			}
		}
		k = key[i];
		if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) return null;
		if (!hasOwn) {
			let unsafe = k === "__proto__";
			if (ctx.uk && (unsafe || k === "constructor")) return false;
			if (unsafe) {
				Object.defineProperty(t, k, {
					enumerable: true,
					configurable: true,
					writable: true
				});
				Object.defineProperty(m, k, {
					enumerable: true,
					configurable: true,
					writable: true
				});
			}
			m[k] = {
				t: i < key.length - 1 && type === 2 ? 3 : type,
				d: false,
				i: 0,
				c: Object.create(null)
			};
		}
	}
	state = m[k];
	if (state.t !== type && !(type === 1 && state.t === 3)) return null;
	if (type === 2) {
		if (!state.d) {
			state.d = true;
			t[k] = [];
		}
		t[k].push(t = Object.create(null));
		state.c[state.i++] = state = {
			t: 1,
			d: false,
			i: 0,
			c: Object.create(null)
		};
	}
	if (state.d) return null;
	state.d = true;
	if (type === 1) t = hasOwn ? t[k] : t[k] = Object.create(null);
	else if (type === 0 && hasOwn) return null;
	return [
		k,
		t,
		state.c
	];
}
function validateTablePeek(ctx, peek, ptr) {
	if (peek === null || ctx.uk === 2) TomlError.x(peek === null ? "trying to redefine an already defined table or value" : "document contains an unsafe property", ctx, ptr);
}
function parse$2(toml, options = {}) {
	let ctx = {
		s: toml,
		p: 0,
		d: options.maxDepth ?? 1e3,
		bi: options.integersAsBigInt ?? false,
		ld: options.useLegacyDate ?? true,
		uk: options.unsafeKeyBehaviour === "throw" ? 2 : options.unsafeKeyBehaviour === "drop" ? 1 : 0
	};
	let res = Object.create(null);
	let meta = Object.create(null);
	let tmp;
	let skipping = false;
	let tbl = res;
	let m = meta;
	if (toml.charCodeAt(0) === 65279) ctx.p++;
	skipVoid(ctx);
	while (ctx.p < toml.length) {
		if (toml.charCodeAt(ctx.p) === 91) {
			let isTableArray = toml.charCodeAt(++ctx.p) === 91;
			tmp = ctx.p += +isTableArray;
			skipping = false;
			let k = parseKey(ctx, 93);
			if (isTableArray) {
				if (toml.charCodeAt(ctx.p) !== 93) TomlError.x("expected end of table array declaration", ctx);
				ctx.p++;
			}
			let p = peekTable(ctx, k, res, meta, isTableArray ? 2 : 1);
			if (!p) {
				validateTablePeek(ctx, p, tmp);
				skipping = true;
			} else {
				m = p[2];
				tbl = p[1];
			}
		} else {
			tmp = ctx.p;
			let p = peekTable(ctx, parseKey(ctx), tbl, m, 0);
			if (!p && !skipping) validateTablePeek(ctx, p, tmp);
			skipVoid(ctx, true, true);
			let v = extractValue(ctx, void 0);
			if (p && !skipping) p[1][p[0]] = v;
		}
		skipVoid(ctx, true);
		if (ctx.p < toml.length && (tmp = toml.charCodeAt(ctx.p)) !== 10 && (tmp !== 13 || toml.charCodeAt(ctx.p + 1) !== 10)) TomlError.x("each key-value declaration must be followed by an end-of-line", ctx);
		skipVoid(ctx);
	}
	return res;
}

// node_modules/smol-toml/dist/stringify.js
/*!
* Copyright (c) Squirrel Chat et al., All rights reserved.
* SPDX-License-Identifier: BSD-3-Clause
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*
* 1. Redistributions of source code must retain the above copyright notice, this
*    list of conditions and the following disclaimer.
* 2. Redistributions in binary form must reproduce the above copyright notice,
*    this list of conditions and the following disclaimer in the
*    documentation and/or other materials provided with the distribution.
* 3. Neither the name of the copyright holder nor the names of its contributors
*    may be used to endorse or promote products derived from this software without
*    specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
* ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
* WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
* DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
* FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
* DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
* SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
* CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
* OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
* OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
let HAS_WELLFORMED = !!"".isWellFormed;

// node_modules/smol-toml/dist/index.js
/*!
* Copyright (c) Squirrel Chat et al., All rights reserved.
* SPDX-License-Identifier: BSD-3-Clause
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*
* 1. Redistributions of source code must retain the above copyright notice, this
*    list of conditions and the following disclaimer.
* 2. Redistributions in binary form must reproduce the above copyright notice,
*    this list of conditions and the following disclaimer in the
*    documentation and/or other materials provided with the distribution.
* 3. Neither the name of the copyright holder nor the names of its contributors
*    may be used to endorse or promote products derived from this software without
*    specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
* ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
* WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
* DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
* FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
* DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
* SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
* CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
* OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
* OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

// src/evidence/uv-toml.ts
var UvFailure = class extends Error {
	reason;
	constructor(reason) {
		super(reason);
		this.reason = reason;
	}
};
function need(value, reason = "malformed") {
	if (!value) throw new UvFailure(reason);
}
function reason(error) {
	return error instanceof UvFailure ? error.reason : "malformed";
}
function debit(budget, key, limit) {
	need(budget[key] < limit, "budget");
	budget[key]++;
}
function newBudget() {
	return {
		entries: 0,
		packages: 0,
		declarations: 0,
		edges: 0
	};
}
function copyDocument(raw, limits, budget) {
	const value = {};
	const stack = [{
		from: raw,
		to: value,
		depth: 1
	}];
	while (stack.length) {
		const { from, to, depth } = stack.pop();
		need(depth <= limits.maxTomlDepth, "budget");
		for (const [key, child] of Object.entries(from)) {
			debit(budget, "entries", limits.maxTomlEntries);
			need(![
				"__proto__",
				"constructor",
				"prototype"
			].includes(key));
			need(Buffer.byteLength(key) <= limits.maxStringBytes, "budget");
			if (typeof child === "string") need(Buffer.byteLength(child) <= limits.maxStringBytes, "budget");
			let copied = child;
			if (child && typeof child === "object" && !(child instanceof Date)) {
				copied = Array.isArray(child) ? [] : {};
				stack.push({
					from: child,
					to: copied,
					depth: depth + 1
				});
			}
			Object.defineProperty(to, key, {
				value: copied,
				enumerable: true,
				writable: true,
				configurable: true
			});
		}
	}
	return value;
}
/** Bytes bound parser work/allocation first; the iterative entry pass is not a parser hook. */
function readToml(bytes, limits, budget = newBudget()) {
	try {
		need(bytes.byteLength <= limits.maxFileBytes, "budget");
		const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return {
			kind: "parsed",
			value: copyDocument(parse$2(source, {
				maxDepth: limits.maxTomlDepth,
				unsafeKeyBehaviour: "throw",
				integersAsBigInt: true
			}), limits, budget)
		};
	} catch (error) {
		return {
			kind: "unavailable",
			reason: error instanceof TomlError && error.message.startsWith("Invalid TOML document: document contains excessively nested structures. aborting.\n") || error instanceof RangeError ? "budget" : reason(error)
		};
	}
}

// node_modules/semver/internal/constants.js
var require_constants = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const SEMVER_SPEC_VERSION = "2.0.0";
	const MAX_LENGTH = 256;
	const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER || 
	/* istanbul ignore next */ 9007199254740991;
	const MAX_SAFE_COMPONENT_LENGTH = 16;
	const MAX_SAFE_BUILD_LENGTH = 250;
	const WHITESPACE_CHARACTERS = [
		"	",
		"\n",
		"\v",
		"\f",
		"\r",
		" ",
		"\xA0",
		" ",
		" ",
		" ",
		" ",
		" ",
		" ",
		" ",
		" ",
		" ",
		" ",
		" ",
		" ",
		"\u2028",
		"\u2029",
		" ",
		" ",
		"　",
		"﻿"
	];
	const RELEASE_TYPES = [
		"major",
		"premajor",
		"minor",
		"preminor",
		"patch",
		"prepatch",
		"prerelease"
	];
	module.exports = {
		MAX_LENGTH,
		MAX_SAFE_COMPONENT_LENGTH,
		MAX_SAFE_BUILD_LENGTH,
		MAX_SAFE_INTEGER,
		WHITESPACE_CHARACTERS,
		RELEASE_TYPES,
		SEMVER_SPEC_VERSION,
		FLAG_INCLUDE_PRERELEASE: 1,
		FLAG_LOOSE: 2
	};
}));

// node_modules/semver/internal/debug.js
var require_debug = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const debug = typeof process === "object" && process.env && process.env.NODE_DEBUG && /\bsemver\b/i.test(process.env.NODE_DEBUG) ? (...args) => console.error("SEMVER", ...args) : () => {};
	module.exports = debug;
}));

// node_modules/semver/internal/re.js
var require_re = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { MAX_SAFE_COMPONENT_LENGTH, MAX_SAFE_BUILD_LENGTH, MAX_LENGTH } = require_constants();
	const debug = require_debug();
	exports = module.exports = {};
	const re = exports.re = [];
	const safeRe = exports.safeRe = [];
	const src = exports.src = [];
	const safeSrc = exports.safeSrc = [];
	const t = exports.t = {};
	let R = 0;
	const LETTERDASHNUMBER = "[a-zA-Z0-9-]";
	const safeRegexReplacements = [
		["\\s", 1],
		["\\d", MAX_LENGTH],
		[LETTERDASHNUMBER, MAX_SAFE_BUILD_LENGTH]
	];
	const makeSafeRegex = (value) => {
		for (const [token, max] of safeRegexReplacements) value = value.split(`${token}*`).join(`${token}{0,${max}}`).split(`${token}+`).join(`${token}{1,${max}}`);
		return value;
	};
	const createToken = (name, value, isGlobal) => {
		const safe = makeSafeRegex(value);
		const index = R++;
		debug(name, index, value);
		t[name] = index;
		src[index] = value;
		safeSrc[index] = safe;
		re[index] = new RegExp(value, isGlobal ? "g" : void 0);
		safeRe[index] = new RegExp(safe, isGlobal ? "g" : void 0);
	};
	createToken("NUMERICIDENTIFIER", "0|[1-9]\\d*");
	createToken("NUMERICIDENTIFIERLOOSE", "\\d+");
	createToken("NONNUMERICIDENTIFIER", `\\d*[a-zA-Z-]${LETTERDASHNUMBER}*`);
	createToken("MAINVERSION", `(${src[t.NUMERICIDENTIFIER]})\\.(${src[t.NUMERICIDENTIFIER]})\\.(${src[t.NUMERICIDENTIFIER]})`);
	createToken("MAINVERSIONLOOSE", `(${src[t.NUMERICIDENTIFIERLOOSE]})\\.(${src[t.NUMERICIDENTIFIERLOOSE]})\\.(${src[t.NUMERICIDENTIFIERLOOSE]})`);
	createToken("PRERELEASEIDENTIFIER", `(?:${src[t.NONNUMERICIDENTIFIER]}|${src[t.NUMERICIDENTIFIER]})`);
	createToken("PRERELEASEIDENTIFIERLOOSE", `(?:${src[t.NONNUMERICIDENTIFIER]}|${src[t.NUMERICIDENTIFIERLOOSE]})`);
	createToken("PRERELEASE", `(?:-(${src[t.PRERELEASEIDENTIFIER]}(?:\\.${src[t.PRERELEASEIDENTIFIER]})*))`);
	createToken("PRERELEASELOOSE", `(?:-?(${src[t.PRERELEASEIDENTIFIERLOOSE]}(?:\\.${src[t.PRERELEASEIDENTIFIERLOOSE]})*))`);
	createToken("BUILDIDENTIFIER", `${LETTERDASHNUMBER}+`);
	createToken("BUILD", `(?:\\+(${src[t.BUILDIDENTIFIER]}(?:\\.${src[t.BUILDIDENTIFIER]})*))`);
	createToken("FULLPLAIN", `v?${src[t.MAINVERSION]}${src[t.PRERELEASE]}?${src[t.BUILD]}?`);
	createToken("FULL", `^${src[t.FULLPLAIN]}$`);
	createToken("LOOSEPLAIN", `[v=\\s]*${src[t.MAINVERSIONLOOSE]}${src[t.PRERELEASELOOSE]}?${src[t.BUILD]}?`);
	createToken("LOOSE", `^${src[t.LOOSEPLAIN]}$`);
	createToken("GTLT", "((?:<|>)?=?)");
	createToken("XRANGEIDENTIFIERLOOSE", `${src[t.NUMERICIDENTIFIERLOOSE]}|x|X|\\*`);
	createToken("XRANGEIDENTIFIER", `${src[t.NUMERICIDENTIFIER]}|x|X|\\*`);
	createToken("XRANGEPLAIN", `[v=\\s]*(${src[t.XRANGEIDENTIFIER]})(?:\\.(${src[t.XRANGEIDENTIFIER]})(?:\\.(${src[t.XRANGEIDENTIFIER]})(?:${src[t.PRERELEASE]})?${src[t.BUILD]}?)?)?`);
	createToken("XRANGEPLAINLOOSE", `[v=\\s]*(${src[t.XRANGEIDENTIFIERLOOSE]})(?:\\.(${src[t.XRANGEIDENTIFIERLOOSE]})(?:\\.(${src[t.XRANGEIDENTIFIERLOOSE]})(?:${src[t.PRERELEASELOOSE]})?${src[t.BUILD]}?)?)?`);
	createToken("XRANGE", `^${src[t.GTLT]}\\s*${src[t.XRANGEPLAIN]}$`);
	createToken("XRANGELOOSE", `^${src[t.GTLT]}\\s*${src[t.XRANGEPLAINLOOSE]}$`);
	createToken("COERCEPLAIN", `(^|[^\\d])(\\d{1,${MAX_SAFE_COMPONENT_LENGTH}})(?:\\.(\\d{1,${MAX_SAFE_COMPONENT_LENGTH}}))?(?:\\.(\\d{1,${MAX_SAFE_COMPONENT_LENGTH}}))?`);
	createToken("COERCE", `${src[t.COERCEPLAIN]}(?:$|[^\\d])`);
	createToken("COERCEFULL", src[t.COERCEPLAIN] + `(?:${src[t.PRERELEASE]})?(?:${src[t.BUILD]})?(?:$|[^\\d])`);
	createToken("COERCERTL", src[t.COERCE], true);
	createToken("COERCERTLFULL", src[t.COERCEFULL], true);
	createToken("LONETILDE", "(?:~>?)");
	createToken("TILDETRIM", `(\\s*)${src[t.LONETILDE]}\\s+`, true);
	exports.tildeTrimReplace = "$1~";
	createToken("TILDE", `^${src[t.LONETILDE]}${src[t.XRANGEPLAIN]}$`);
	createToken("TILDELOOSE", `^${src[t.LONETILDE]}${src[t.XRANGEPLAINLOOSE]}$`);
	createToken("LONECARET", "(?:\\^)");
	createToken("CARETTRIM", `(\\s*)${src[t.LONECARET]}\\s+`, true);
	exports.caretTrimReplace = "$1^";
	createToken("CARET", `^${src[t.LONECARET]}${src[t.XRANGEPLAIN]}$`);
	createToken("CARETLOOSE", `^${src[t.LONECARET]}${src[t.XRANGEPLAINLOOSE]}$`);
	createToken("COMPARATORLOOSE", `^${src[t.GTLT]}\\s*(${src[t.LOOSEPLAIN]})$|^$`);
	createToken("COMPARATOR", `^${src[t.GTLT]}\\s*(${src[t.FULLPLAIN]})$|^$`);
	createToken("COMPARATORTRIM", `(\\s*)${src[t.GTLT]}\\s*(${src[t.LOOSEPLAIN]}|${src[t.XRANGEPLAIN]})`, true);
	exports.comparatorTrimReplace = "$1$2$3";
	createToken("HYPHENRANGE", `^\\s*(${src[t.XRANGEPLAIN]})\\s+-\\s+(${src[t.XRANGEPLAIN]})\\s*$`);
	createToken("HYPHENRANGELOOSE", `^\\s*(${src[t.XRANGEPLAINLOOSE]})\\s+-\\s+(${src[t.XRANGEPLAINLOOSE]})\\s*$`);
	createToken("STAR", "(<|>)?=?\\s*\\*");
	createToken("GTE0", "^\\s*>=\\s*0\\.0\\.0\\s*$");
	createToken("GTE0PRE", "^\\s*>=\\s*0\\.0\\.0-0\\s*$");
}));

// node_modules/semver/internal/parse-options.js
var require_parse_options = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const looseOption = Object.freeze({ loose: true });
	const emptyOpts = Object.freeze({});
	const parseOptions = (options) => {
		if (!options) return emptyOpts;
		if (typeof options !== "object") return looseOption;
		return options;
	};
	module.exports = parseOptions;
}));

// node_modules/semver/internal/identifiers.js
var require_identifiers = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const numeric = /^[0-9]+$/;
	const compareIdentifiers = (a, b) => {
		if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
		const anum = numeric.test(a);
		const bnum = numeric.test(b);
		if (anum && bnum) {
			a = +a;
			b = +b;
		}
		return a === b ? 0 : anum && !bnum ? -1 : bnum && !anum ? 1 : a < b ? -1 : 1;
	};
	const rcompareIdentifiers = (a, b) => compareIdentifiers(b, a);
	module.exports = {
		compareIdentifiers,
		rcompareIdentifiers
	};
}));

// node_modules/semver/classes/semver.js
var require_semver$1 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const debug = require_debug();
	const { MAX_LENGTH, MAX_SAFE_INTEGER } = require_constants();
	const { safeRe: re, t } = require_re();
	const parseOptions = require_parse_options();
	const { compareIdentifiers } = require_identifiers();
	const isPrereleaseIdentifier = (prerelease, identifier) => {
		const identifiers = identifier.split(".");
		if (identifiers.length > prerelease.length) return false;
		for (let i = 0; i < identifiers.length; i++) if (compareIdentifiers(prerelease[i], identifiers[i]) !== 0) return false;
		return true;
	};
	var SemVer = class SemVer {
		constructor(version, options) {
			options = parseOptions(options);
			if (version instanceof SemVer) {
				if (version.loose === !!options.loose && version.includePrerelease === !!options.includePrerelease) return version;
				else version = version.version;
			} else if (typeof version !== "string") throw new TypeError(`Invalid version. Must be a string. Got type "${typeof version}".`);
			if (version.length > MAX_LENGTH) throw new TypeError(`version is longer than ${MAX_LENGTH} characters`);
			debug("SemVer", version, options);
			this.options = options;
			this.loose = !!options.loose;
			this.includePrerelease = !!options.includePrerelease;
			const m = version.trim().match(options.loose ? re[t.LOOSE] : re[t.FULL]);
			if (!m) throw new TypeError(`Invalid Version: ${version}`);
			this.raw = version;
			this.major = +m[1];
			this.minor = +m[2];
			this.patch = +m[3];
			if (this.major > MAX_SAFE_INTEGER || this.major < 0) throw new TypeError("Invalid major version");
			if (this.minor > MAX_SAFE_INTEGER || this.minor < 0) throw new TypeError("Invalid minor version");
			if (this.patch > MAX_SAFE_INTEGER || this.patch < 0) throw new TypeError("Invalid patch version");
			if (!m[4]) this.prerelease = [];
			else this.prerelease = m[4].split(".").map((id) => {
				if (/^[0-9]+$/.test(id)) {
					const num = +id;
					if (num >= 0 && num < MAX_SAFE_INTEGER) return num;
				}
				return id;
			});
			this.build = m[5] ? m[5].split(".") : [];
			this.format();
		}
		format() {
			this.version = `${this.major}.${this.minor}.${this.patch}`;
			if (this.prerelease.length) this.version += `-${this.prerelease.join(".")}`;
			return this.version;
		}
		toString() {
			return this.version;
		}
		compare(other) {
			debug("SemVer.compare", this.version, this.options, other);
			if (!(other instanceof SemVer)) {
				if (typeof other === "string" && other === this.version) return 0;
				other = new SemVer(other, this.options);
			}
			if (other.version === this.version) return 0;
			return this.compareMain(other) || this.comparePre(other);
		}
		compareMain(other) {
			if (!(other instanceof SemVer)) other = new SemVer(other, this.options);
			if (this.major < other.major) return -1;
			if (this.major > other.major) return 1;
			if (this.minor < other.minor) return -1;
			if (this.minor > other.minor) return 1;
			if (this.patch < other.patch) return -1;
			if (this.patch > other.patch) return 1;
			return 0;
		}
		comparePre(other) {
			if (!(other instanceof SemVer)) other = new SemVer(other, this.options);
			if (this.prerelease.length && !other.prerelease.length) return -1;
			else if (!this.prerelease.length && other.prerelease.length) return 1;
			else if (!this.prerelease.length && !other.prerelease.length) return 0;
			let i = 0;
			do {
				const a = this.prerelease[i];
				const b = other.prerelease[i];
				debug("prerelease compare", i, a, b);
				if (a === void 0 && b === void 0) return 0;
				else if (b === void 0) return 1;
				else if (a === void 0) return -1;
				else if (a === b) continue;
				else return compareIdentifiers(a, b);
			} while (++i);
		}
		compareBuild(other) {
			if (!(other instanceof SemVer)) other = new SemVer(other, this.options);
			let i = 0;
			do {
				const a = this.build[i];
				const b = other.build[i];
				debug("build compare", i, a, b);
				if (a === void 0 && b === void 0) return 0;
				else if (b === void 0) return 1;
				else if (a === void 0) return -1;
				else if (a === b) continue;
				else return compareIdentifiers(a, b);
			} while (++i);
		}
		inc(release, identifier, identifierBase) {
			if (release.startsWith("pre")) {
				if (!identifier && identifierBase === false) throw new Error("invalid increment argument: identifier is empty");
				if (identifier) {
					const match = `-${identifier}`.match(this.options.loose ? re[t.PRERELEASELOOSE] : re[t.PRERELEASE]);
					if (!match || match[1] !== identifier) throw new Error(`invalid identifier: ${identifier}`);
				}
			}
			switch (release) {
				case "premajor":
					this.prerelease.length = 0;
					this.patch = 0;
					this.minor = 0;
					this.major++;
					this.inc("pre", identifier, identifierBase);
					break;
				case "preminor":
					this.prerelease.length = 0;
					this.patch = 0;
					this.minor++;
					this.inc("pre", identifier, identifierBase);
					break;
				case "prepatch":
					this.prerelease.length = 0;
					this.inc("patch", identifier, identifierBase);
					this.inc("pre", identifier, identifierBase);
					break;
				case "prerelease":
					if (this.prerelease.length === 0) this.inc("patch", identifier, identifierBase);
					this.inc("pre", identifier, identifierBase);
					break;
				case "release":
					if (this.prerelease.length === 0) throw new Error(`version ${this.raw} is not a prerelease`);
					this.prerelease.length = 0;
					break;
				case "major":
					if (this.minor !== 0 || this.patch !== 0 || this.prerelease.length === 0) this.major++;
					this.minor = 0;
					this.patch = 0;
					this.prerelease = [];
					break;
				case "minor":
					if (this.patch !== 0 || this.prerelease.length === 0) this.minor++;
					this.patch = 0;
					this.prerelease = [];
					break;
				case "patch":
					if (this.prerelease.length === 0) this.patch++;
					this.prerelease = [];
					break;
				case "pre": {
					const base = Number(identifierBase) ? 1 : 0;
					if (this.prerelease.length === 0) this.prerelease = [base];
					else {
						let i = this.prerelease.length;
						while (--i >= 0) if (typeof this.prerelease[i] === "number") {
							this.prerelease[i]++;
							i = -2;
						}
						if (i === -1) {
							if (identifier === this.prerelease.join(".") && identifierBase === false) throw new Error("invalid increment argument: identifier already exists");
							this.prerelease.push(base);
						}
					}
					if (identifier) {
						let prerelease = [identifier, base];
						if (identifierBase === false) prerelease = [identifier];
						if (isPrereleaseIdentifier(this.prerelease, identifier)) {
							const prereleaseBase = this.prerelease[identifier.split(".").length];
							if (isNaN(prereleaseBase)) this.prerelease = prerelease;
						} else this.prerelease = prerelease;
					}
					break;
				}
				default: throw new Error(`invalid increment argument: ${release}`);
			}
			this.raw = this.format();
			if (this.build.length) this.raw += `+${this.build.join(".")}`;
			return this;
		}
	};
	module.exports = SemVer;
}));

// node_modules/semver/functions/parse.js
var require_parse = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const SemVer = require_semver$1();
	const parse = (version, options, throwErrors = false) => {
		if (version instanceof SemVer) return version;
		try {
			return new SemVer(version, options);
		} catch (er) {
			if (!throwErrors) return null;
			throw er;
		}
	};
	module.exports = parse;
}));

// node_modules/semver/functions/valid.js
var require_valid$1 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const parse = require_parse();
	const valid = (version, options) => {
		const v = parse(version, options);
		return v ? v.version : null;
	};
	module.exports = valid;
}));

// node_modules/semver/functions/clean.js
var require_clean = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const parse = require_parse();
	const clean = (version, options) => {
		const s = parse(version.trim().replace(/^[=v]+/, ""), options);
		return s ? s.version : null;
	};
	module.exports = clean;
}));

// node_modules/semver/functions/inc.js
var require_inc = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const SemVer = require_semver$1();
	const inc = (version, release, options, identifier, identifierBase) => {
		if (typeof options === "string") {
			identifierBase = identifier;
			identifier = options;
			options = void 0;
		}
		try {
			return new SemVer(version instanceof SemVer ? version.version : version, options).inc(release, identifier, identifierBase).version;
		} catch (er) {
			return null;
		}
	};
	module.exports = inc;
}));

// node_modules/semver/functions/diff.js
var require_diff = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const parse = require_parse();
	const diff = (version1, version2) => {
		const v1 = parse(version1, null, true);
		const v2 = parse(version2, null, true);
		const comparison = v1.compare(v2);
		if (comparison === 0) return null;
		const v1Higher = comparison > 0;
		const highVersion = v1Higher ? v1 : v2;
		const lowVersion = v1Higher ? v2 : v1;
		const highHasPre = !!highVersion.prerelease.length;
		if (!!lowVersion.prerelease.length && !highHasPre) {
			if (!lowVersion.patch && !lowVersion.minor) return "major";
			if (lowVersion.compareMain(highVersion) === 0) {
				if (lowVersion.minor && !lowVersion.patch) return "minor";
				return "patch";
			}
		}
		const prefix = highHasPre ? "pre" : "";
		if (v1.major !== v2.major) return prefix + "major";
		if (v1.minor !== v2.minor) return prefix + "minor";
		if (v1.patch !== v2.patch) return prefix + "patch";
		return "prerelease";
	};
	module.exports = diff;
}));

// node_modules/semver/functions/major.js
var require_major = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const SemVer = require_semver$1();
	const major = (a, loose) => new SemVer(a, loose).major;
	module.exports = major;
}));

// node_modules/semver/functions/minor.js
var require_minor = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const SemVer = require_semver$1();
	const minor = (a, loose) => new SemVer(a, loose).minor;
	module.exports = minor;
}));

// node_modules/semver/functions/patch.js
var require_patch = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const SemVer = require_semver$1();
	const patch = (a, loose) => new SemVer(a, loose).patch;
	module.exports = patch;
}));

// node_modules/semver/functions/prerelease.js
var require_prerelease = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const parse = require_parse();
	const prerelease = (version, options) => {
		const parsed = parse(version, options);
		return parsed && parsed.prerelease.length ? parsed.prerelease : null;
	};
	module.exports = prerelease;
}));

// node_modules/semver/functions/compare.js
var require_compare = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const SemVer = require_semver$1();
	const compare = (a, b, loose) => new SemVer(a, loose).compare(new SemVer(b, loose));
	module.exports = compare;
}));

// node_modules/semver/functions/rcompare.js
var require_rcompare = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const compare = require_compare();
	const rcompare = (a, b, loose) => compare(b, a, loose);
	module.exports = rcompare;
}));

// node_modules/semver/functions/compare-loose.js
var require_compare_loose = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const compare = require_compare();
	const compareLoose = (a, b) => compare(a, b, true);
	module.exports = compareLoose;
}));

// node_modules/semver/functions/compare-build.js
var require_compare_build = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const SemVer = require_semver$1();
	const compareBuild = (a, b, loose) => {
		const versionA = new SemVer(a, loose);
		const versionB = new SemVer(b, loose);
		return versionA.compare(versionB) || versionA.compareBuild(versionB);
	};
	module.exports = compareBuild;
}));

// node_modules/semver/functions/sort.js
var require_sort = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const compareBuild = require_compare_build();
	const sort = (list, loose) => list.sort((a, b) => compareBuild(a, b, loose));
	module.exports = sort;
}));

// node_modules/semver/functions/rsort.js
var require_rsort = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const compareBuild = require_compare_build();
	const rsort = (list, loose) => list.sort((a, b) => compareBuild(b, a, loose));
	module.exports = rsort;
}));

// node_modules/semver/functions/gt.js
var require_gt = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const compare = require_compare();
	const gt = (a, b, loose) => compare(a, b, loose) > 0;
	module.exports = gt;
}));

// node_modules/semver/functions/lt.js
var require_lt = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const compare = require_compare();
	const lt = (a, b, loose) => compare(a, b, loose) < 0;
	module.exports = lt;
}));

// node_modules/semver/functions/eq.js
var require_eq = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const compare = require_compare();
	const eq = (a, b, loose) => compare(a, b, loose) === 0;
	module.exports = eq;
}));

// node_modules/semver/functions/neq.js
var require_neq = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const compare = require_compare();
	const neq = (a, b, loose) => compare(a, b, loose) !== 0;
	module.exports = neq;
}));

// node_modules/semver/functions/gte.js
var require_gte = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const compare = require_compare();
	const gte = (a, b, loose) => compare(a, b, loose) >= 0;
	module.exports = gte;
}));

// node_modules/semver/functions/lte.js
var require_lte = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const compare = require_compare();
	const lte = (a, b, loose) => compare(a, b, loose) <= 0;
	module.exports = lte;
}));

// node_modules/semver/functions/cmp.js
var require_cmp = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const eq = require_eq();
	const neq = require_neq();
	const gt = require_gt();
	const gte = require_gte();
	const lt = require_lt();
	const lte = require_lte();
	const cmp = (a, op, b, loose) => {
		switch (op) {
			case "===":
				if (typeof a === "object") a = a.version;
				if (typeof b === "object") b = b.version;
				return a === b;
			case "!==":
				if (typeof a === "object") a = a.version;
				if (typeof b === "object") b = b.version;
				return a !== b;
			case "":
			case "=":
			case "==": return eq(a, b, loose);
			case "!=": return neq(a, b, loose);
			case ">": return gt(a, b, loose);
			case ">=": return gte(a, b, loose);
			case "<": return lt(a, b, loose);
			case "<=": return lte(a, b, loose);
			default: throw new TypeError(`Invalid operator: ${op}`);
		}
	};
	module.exports = cmp;
}));

// node_modules/semver/functions/coerce.js
var require_coerce = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const SemVer = require_semver$1();
	const parse = require_parse();
	const { safeRe: re, t } = require_re();
	const coerce = (version, options) => {
		if (version instanceof SemVer) return version;
		if (typeof version === "number") version = String(version);
		if (typeof version !== "string") return null;
		options = options || {};
		let match = null;
		if (!options.rtl) match = version.match(options.includePrerelease ? re[t.COERCEFULL] : re[t.COERCE]);
		else {
			const coerceRtlRegex = options.includePrerelease ? re[t.COERCERTLFULL] : re[t.COERCERTL];
			let next;
			while ((next = coerceRtlRegex.exec(version)) && (!match || match.index + match[0].length !== version.length)) {
				if (!match || next.index + next[0].length !== match.index + match[0].length) match = next;
				coerceRtlRegex.lastIndex = next.index + next[1].length + next[2].length;
			}
			coerceRtlRegex.lastIndex = -1;
		}
		if (match === null) return null;
		const major = match[2];
		const minor = match[3] || "0";
		const patch = match[4] || "0";
		const prerelease = options.includePrerelease && match[5] ? `-${match[5]}` : "";
		const build = options.includePrerelease && match[6] ? `+${match[6]}` : "";
		return parse(`${major}.${minor}.${patch}${prerelease}${build}`, options);
	};
	module.exports = coerce;
}));

// node_modules/semver/functions/truncate.js
var require_truncate = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const parse = require_parse();
	const constants = require_constants();
	const SemVer = require_semver$1();
	const truncate = (version, truncation, options) => {
		if (!constants.RELEASE_TYPES.includes(truncation)) return null;
		const clonedVersion = cloneInputVersion(version, options);
		return clonedVersion && doTruncation(clonedVersion, truncation);
	};
	const cloneInputVersion = (version, options) => {
		const versionStringToParse = version instanceof SemVer ? version.version : version;
		return parse(versionStringToParse, options);
	};
	const doTruncation = (version, truncation) => {
		if (isPrerelease(truncation)) return version.version;
		version.prerelease = [];
		switch (truncation) {
			case "major":
				version.minor = 0;
				version.patch = 0;
				break;
			case "minor": version.patch = 0;
		}
		return version.format();
	};
	const isPrerelease = (type) => {
		return type.startsWith("pre");
	};
	module.exports = truncate;
}));

// node_modules/semver/internal/lrucache.js
var require_lrucache = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var LRUCache = class {
		constructor() {
			this.max = 1e3;
			this.map = /* @__PURE__ */ new Map();
		}
		get(key) {
			const value = this.map.get(key);
			if (value === void 0) return;
			else {
				this.map.delete(key);
				this.map.set(key, value);
				return value;
			}
		}
		delete(key) {
			return this.map.delete(key);
		}
		set(key, value) {
			if (!this.delete(key) && value !== void 0) {
				if (this.map.size >= this.max) {
					const firstKey = this.map.keys().next().value;
					this.delete(firstKey);
				}
				this.map.set(key, value);
			}
			return this;
		}
	};
	module.exports = LRUCache;
}));

// node_modules/semver/internal/trim-comparator-whitespace.js
var require_trim_comparator_whitespace = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { MAX_LENGTH, MAX_SAFE_BUILD_LENGTH, WHITESPACE_CHARACTERS } = require_constants();
	/**
	* Remembers the last two rows of digits so their characters need not be reread.
	* Positions start at -1 until a row has been found.
	*
	* @typedef {object} DigitRunCache
	* @property {number} start The first character of the most recently found row.
	* @property {number} end The position after that row's last character.
	* @property {number} previousStart The first character of the previous row.
	* @property {number} previousEnd The position after the previous row.
	*/
	const whitespace = /* @__PURE__ */ new Uint8Array(65536);
	for (const char of WHITESPACE_CHARACTERS) whitespace[char.charCodeAt(0)] = 1;
	/**
	* Checks whether a character is whitespace, like a space, tab, or newline.
	* Looking past the end of the string returns false.
	*
	* @param {string|undefined} char One character, or undefined past the string's end.
	* @returns {boolean} Whether the character is whitespace.
	* @example isWhitespace(' ') // true
	* @example isWhitespace('1') // false
	*/
	const isWhitespace = (char) => char !== void 0 && whitespace[char.charCodeAt(0)] === 1;
	/**
	* Checks for v, =, or whitespace before the version number.
	* These are historical version prefixes, not range operators:
	* < and > are handled separately, as are tilde and caret ranges.
	*
	* @param {string|undefined} char One character to check.
	* @returns {boolean} Whether the character can belong to a version prefix.
	* @example isVersionPrefix('=') // true
	* @example isVersionPrefix('>') // false
	*/
	const isVersionPrefix = (char) => char === "v" || char === "=" || isWhitespace(char);
	/**
	* Checks whether a character is one of the digits 0 through 9.
	*
	* @param {string|undefined} char One character to check.
	* @returns {boolean} Whether the character is an ASCII digit.
	* @example isDigit('7') // true
	* @example isDigit('.') // false
	*/
	const isDigit = (char) => char !== void 0 && char >= "0" && char <= "9";
	/**
	* Checks whether a character is an English letter, uppercase or lowercase.
	*
	* @param {string|undefined} char One character to check.
	* @returns {boolean} Whether the character is an ASCII letter.
	* @example isLetter('b') // true
	* @example isLetter('7') // false
	*/
	const isLetter = (char) => char !== void 0 && (char >= "a" && char <= "z" || char >= "A" && char <= "Z");
	/**
	* Checks for a letter, digit, or hyphen: the characters allowed inside
	* prerelease and build names such as beta-1.
	*
	* @param {string|undefined} char One character to check.
	* @returns {boolean} Whether the character can be part of an identifier.
	* @example isIdentifierCharacter('-') // true
	* @example isIdentifierCharacter('.') // false; dots separate identifiers
	*/
	const isIdentifierCharacter = (char) => isDigit(char) || isLetter(char) || char === "-";
	/**
	* Checks whether a version component can begin here: with a digit or
	* a wildcard such as x, X, or *.
	*
	* @param {string|undefined} char One character to check.
	* @returns {boolean} Whether a number or wildcard can start with this character.
	* @example isVersionStart('x') // true
	* @example isVersionStart('v') // false; v belongs to the prefix
	*/
	const isVersionStart = (char) => isDigit(char) || char === "x" || char === "X" || char === "*";
	/**
	* Finds the end of a row of digits, but returns no more than limit digits.
	* Remembers the last two rows so looking at them again does not reread them.
	*
	* @param {string} range The text to read; it is not changed.
	* @param {number} start The position of the first character to check.
	* @param {number} limit The most digit characters the returned match can include.
	* @param {DigitRunCache} digitRuns Shared cache of digit-run positions, updated in place.
	* @returns {number} The position after the matched digits, or start if none match.
	* @example findDigitsEndIndex('123abc', 0, 10, digitRuns) // 3, pointing at a
	* @example findDigitsEndIndex('123abc', 0, 2, digitRuns) // 2, pointing at the unread 3
	*/
	const findDigitsEndIndex = (range, start, limit, digitRuns) => {
		if (!isDigit(range[start])) return start;
		if (start >= digitRuns.start && start < digitRuns.end) return Math.min(start + limit, digitRuns.end);
		if (start >= digitRuns.previousStart && start < digitRuns.previousEnd) return Math.min(start + limit, digitRuns.previousEnd);
		let end = start + 1;
		while (isDigit(range[end])) end++;
		digitRuns.previousStart = digitRuns.start;
		digitRuns.previousEnd = digitRuns.end;
		digitRuns.start = start;
		digitRuns.end = end;
		return Math.min(start + limit, end);
	};
	/**
	* Reads a number using the old regex's length and leading-zero rules.
	* Strict mode reads just the first zero in 012; loose mode can read all three.
	*
	* @param {string} range The text to read; it is not changed.
	* @param {number} start The position where the number should begin.
	* @param {boolean} loose Whether to allow leading zeros.
	* @param {DigitRunCache} digitRuns Shared digit-run cache, updated as needed.
	* @returns {number} The position after the matched digits, not their numeric value.
	* @example findVersionNumberEndIndex('012', 0, false, digitRuns) // 1
	* @example findVersionNumberEndIndex('012', 0, true, digitRuns) // 3
	*/
	const findVersionNumberEndIndex = (range, start, loose, digitRuns) => {
		if (!loose && range[start] === "0") return start + 1;
		return findDigitsEndIndex(range, start, loose ? MAX_LENGTH : MAX_LENGTH + 1, digitRuns);
	};
	/**
	* Reads one piece of a prerelease name, such as beta or 1 in beta.1.
	* Tries the letter-or-hyphen form first, then the number-only form.
	*
	* @param {string} range The text to read; it is not changed.
	* @param {number} start The position where the identifier should begin.
	* @param {boolean} loose Whether numeric identifiers may have leading zeros.
	* @param {DigitRunCache} digitRuns Shared digit-run cache, updated as needed.
	* @returns {number} The position after the identifier, or start if none matches.
	* @example findPrereleaseIdentifierEndIndex('beta.1', 0, false, digitRuns) // 4, at the dot
	* @example findPrereleaseIdentifierEndIndex('001beta', 0, false, digitRuns) // 7
	*/
	const findPrereleaseIdentifierEndIndex = (range, start, loose, digitRuns) => {
		const digitsEnd = findDigitsEndIndex(range, start, MAX_LENGTH, digitRuns);
		if (isLetter(range[digitsEnd]) || range[digitsEnd] === "-") {
			let end = digitsEnd + 1;
			const limit = end + MAX_SAFE_BUILD_LENGTH;
			while (end < limit && isIdentifierCharacter(range[end])) end++;
			return end;
		}
		return findVersionNumberEndIndex(range, start, loose, digitRuns);
	};
	/**
	* Reads a prerelease suffix such as -beta.1, one dot-separated piece at a time.
	* Loose mode also allows the name without its opening hyphen.
	*
	* @param {string} range The text to read; it is not changed.
	* @param {number} start The position where the suffix should begin, including -.
	* @param {boolean} loose Whether the opening hyphen is optional and zeros allowed.
	* @param {DigitRunCache} digitRuns Shared digit-run cache, updated as needed.
	* @returns {number} The position after the matched suffix, or start if absent.
	* @example findPrereleaseEndIndex('-beta.1+sha', 0, false, digitRuns) // 7, at the plus
	* @example findPrereleaseEndIndex('beta', 0, false, digitRuns) // 0; no opening hyphen
	*/
	const findPrereleaseEndIndex = (range, start, loose, digitRuns) => {
		const hyphen = range[start] === "-";
		if (!loose && !hyphen) return start;
		const identifierStart = start + (hyphen ? 1 : 0);
		let end = findPrereleaseIdentifierEndIndex(range, identifierStart, loose, digitRuns);
		if (end === identifierStart) {
			if (!loose || !hyphen) return start;
			end = findPrereleaseIdentifierEndIndex(range, start, loose, digitRuns);
		}
		while (range[end] === ".") {
			const next = findPrereleaseIdentifierEndIndex(range, end + 1, loose, digitRuns);
			if (next === end + 1) break;
			end = next;
		}
		return end;
	};
	/**
	* Reads one build-name piece, such as sha or 123 in +sha.123.
	* Stops at a disallowed character or the old regex's length limit.
	*
	* @param {string} range The text to read; it is not changed.
	* @param {number} start The position where the identifier should begin.
	* @returns {number} The position after the identifier, or start if none matches.
	* @example findBuildIdentifierEndIndex('sha.123', 0) // 3, at the dot
	* @example findBuildIdentifierEndIndex('001', 0) // 3; leading zeros are allowed
	*/
	const findBuildIdentifierEndIndex = (range, start) => {
		let end = start;
		while (end - start < MAX_SAFE_BUILD_LENGTH && isIdentifierCharacter(range[end])) end++;
		return end;
	};
	/**
	* Reads optional build metadata such as +sha.123.
	* Leaves the position unchanged if there is no plus sign followed by a name.
	*
	* @param {string} range The text to read; it is not changed.
	* @param {number} start The position where the opening + should be.
	* @returns {number} The position after the matched metadata, or start if absent.
	* @example findBuildEndIndex('+sha.123 <2', 0) // 8, at the space
	* @example findBuildEndIndex('+', 0) // 0; a plus sign alone is not a match
	*/
	const findBuildEndIndex = (range, start) => {
		if (range[start] !== "+") return start;
		let end = findBuildIdentifierEndIndex(range, start + 1);
		if (end === start + 1) return start;
		while (range[end] === ".") {
			const next = findBuildIdentifierEndIndex(range, end + 1);
			if (next === end + 1) break;
			end = next;
		}
		return end;
	};
	/**
	* Reads three numbers separated by dots, then any prerelease and build suffixes.
	* Uses loose rules, so forms such as 01.02.03beta can match here.
	*
	* @param {string} range The text to read; it is not changed.
	* @param {number} start The position of the first number, after any prefix.
	* @param {DigitRunCache} digitRuns Shared digit-run cache, updated as needed.
	* @returns {number} The position after the version match, or start if none matches.
	* @example findLooseFullVersionEndIndex('1.2.3-beta+sha <2', 0, digitRuns) // 14
	* @example findLooseFullVersionEndIndex('1.2', 0, digitRuns) // 0; needs three numbers
	*/
	const findLooseFullVersionEndIndex = (range, start, digitRuns) => {
		let end = start;
		for (let component = 0; component < 3; component++) {
			const next = findVersionNumberEndIndex(range, end, true, digitRuns);
			if (next === end) return start;
			end = next;
			if (component < 2) {
				if (range[end] !== ".") return start;
				end++;
			}
		}
		const prereleaseEnd = findPrereleaseEndIndex(range, end, true, digitRuns);
		return findBuildEndIndex(range, prereleaseEnd);
	};
	/**
	* Reads one component of a partial or wildcard version, such as 2 or x in 2.x.
	* Numbers use strict leading-zero rules; wildcards take up one character.
	*
	* @param {string} range The text to read; it is not changed.
	* @param {number} start The position where the component should begin.
	* @param {DigitRunCache} digitRuns Shared digit-run cache, updated as needed.
	* @returns {number} The position after the component, or start if none matches.
	* @example findPartialVersionComponentEndIndex('2.x', 0, digitRuns) // 1, at the dot
	* @example findPartialVersionComponentEndIndex('2.x', 2, digitRuns) // 3, after x
	*/
	const findPartialVersionComponentEndIndex = (range, start, digitRuns) => {
		if (isDigit(range[start])) return findVersionNumberEndIndex(range, start, false, digitRuns);
		return isVersionStart(range[start]) ? start + 1 : start;
	};
	/**
	* Reads up to three components, allowing forms such as 1, 1.2, or 1.x.
	* After the third component, also reads any strict prerelease and build suffixes.
	*
	* @param {string} range The text to read; it is not changed.
	* @param {number} start The position of a number or wildcard, after any prefix.
	* @param {DigitRunCache} digitRuns Shared digit-run cache, updated as needed.
	* @returns {number} The position after the matched version text.
	* @example findPartialVersionEndIndex('1.x <2', 0, digitRuns) // 3, at the space
	* @example findPartialVersionEndIndex('1.', 0, digitRuns) // 1; the trailing dot is unread
	*/
	const findPartialVersionEndIndex = (range, start, digitRuns) => {
		let end = findPartialVersionComponentEndIndex(range, start, digitRuns);
		for (let component = 0; component < 2; component++) {
			if (range[end] !== ".") return end;
			const next = findPartialVersionComponentEndIndex(range, end + 1, digitRuns);
			if (next === end + 1) return end;
			end = next;
		}
		const prereleaseEnd = findPrereleaseEndIndex(range, end, false, digitRuns);
		return findBuildEndIndex(range, prereleaseEnd);
	};
	/**
	* Finds where a version match ends, without deciding whether the range is valid.
	* Tries a loose full version first, then a partial or wildcard version, just
	* like the old regex's LOOSEPLAIN and XRANGEPLAIN alternatives.
	*
	* @param {string} range The text to read; it is not changed.
	* @param {number} start The position of a number or wildcard, after any prefix.
	* @param {DigitRunCache} digitRuns Shared digit-run cache, updated as needed.
	* @returns {number} The position where scanning the next candidate can resume.
	* @example findVersionEndIndex('1.2.3 <2', 0, digitRuns) // 5, at the space
	* @example findVersionEndIndex('1.x <2', 0, digitRuns) // 3, at the space
	*/
	const findVersionEndIndex = (range, start, digitRuns) => {
		const fullVersionEnd = findLooseFullVersionEndIndex(range, start, digitRuns);
		return fullVersionEnd !== start ? fullVersionEnd : findPartialVersionEndIndex(range, start, digitRuns);
	};
	/**
	* Finds the one whitespace character the old replacement would remove.
	* Keeps leading whitespace, skips an optional operator, and checks immediately
	* after it. Returns -1 if there is nothing to remove.
	*
	* @param {string} range The text containing a candidate already found by the caller.
	* @param {number} matchStart The candidate's position, including leading whitespace.
	* @returns {number} The position of the removable whitespace, or -1 if absent.
	* @example findRemovableWhitespaceIndex(' > 1', 0) // 2; keep the space at position 0
	* @example findRemovableWhitespaceIndex('>1', 0) // -1
	*/
	const findRemovableWhitespaceIndex = (range, matchStart) => {
		let position = matchStart;
		if (isWhitespace(range[position])) position++;
		if (range[position] === "<" || range[position] === ">") position++;
		if (range[position] === "=") position++;
		return isWhitespace(range[position]) ? position : -1;
	};
	/**
	* Joins an operator to its version, turning > 1.2.3 into >1.2.3.
	* Copies everything else according to the old regex's matching rules.
	* Moves forward through prefixes and whole versions to avoid repeatedly
	* searching the same characters on long inputs.
	*
	* @param {string} range The range text to process; the original string is unchanged.
	* @returns {string} The range with matched operator whitespace removed.
	* @example trimComparatorWhitespace('> 1.2.3 < 2') // '>1.2.3 <2'
	* @example trimComparatorWhitespace('> invalid') // '> invalid'
	*/
	const trimComparatorWhitespace = (range) => {
		let result = "";
		let copyFrom = 0;
		let cursor = 0;
		const digitRuns = {
			start: -1,
			end: -1,
			previousStart: -1,
			previousEnd: -1
		};
		while (cursor < range.length) {
			const matchStart = cursor;
			if (range[cursor] === "<" || range[cursor] === ">") cursor++;
			else if (!isVersionPrefix(range[cursor]) && !isVersionStart(range[cursor])) {
				cursor++;
				continue;
			}
			while (cursor < range.length && isVersionPrefix(range[cursor])) cursor++;
			if (!isVersionStart(range[cursor])) continue;
			const whitespacePosition = findRemovableWhitespaceIndex(range, matchStart);
			if (whitespacePosition !== -1) {
				result += range.slice(copyFrom, whitespacePosition);
				copyFrom = whitespacePosition + 1;
			}
			cursor = findVersionEndIndex(range, cursor, digitRuns);
		}
		return result + range.slice(copyFrom);
	};
	module.exports = trimComparatorWhitespace;
}));

// node_modules/semver/classes/range.js
var require_range = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const SPACE_CHARACTERS = /\s+/g;
	var Range = class Range {
		constructor(range, options) {
			options = parseOptions(options);
			if (range instanceof Range) {
				if (range.loose === !!options.loose && range.includePrerelease === !!options.includePrerelease) return range;
				else return new Range(range.raw, options);
			}
			if (range instanceof Comparator) {
				this.raw = range.value;
				this.set = [[range]];
				this.formatted = void 0;
				return this;
			}
			this.options = options;
			this.loose = !!options.loose;
			this.includePrerelease = !!options.includePrerelease;
			this.raw = range.trim().replace(SPACE_CHARACTERS, " ");
			this.set = this.raw.split("||").map((r) => this.parseRange(r.trim())).filter((c) => c.length);
			if (!this.set.length) throw new TypeError(`Invalid SemVer Range: ${this.raw}`);
			if (this.set.length > 1) {
				const first = this.set[0];
				this.set = this.set.filter((c) => !isNullSet(c[0]));
				if (this.set.length === 0) this.set = [first];
				else if (this.set.length > 1) {
					for (const c of this.set) if (c.length === 1 && isAny(c[0])) {
						this.set = [c];
						break;
					}
				}
			}
			this.formatted = void 0;
		}
		get range() {
			if (this.formatted === void 0) {
				this.formatted = "";
				for (let i = 0; i < this.set.length; i++) {
					if (i > 0) this.formatted += "||";
					const comps = this.set[i];
					for (let k = 0; k < comps.length; k++) {
						if (k > 0) this.formatted += " ";
						this.formatted += comps[k].toString().trim();
					}
				}
			}
			return this.formatted;
		}
		format() {
			return this.range;
		}
		toString() {
			return this.range;
		}
		parseRange(range) {
			range = range.replace(BUILDSTRIPRE, "");
			const memoKey = ((this.options.includePrerelease && FLAG_INCLUDE_PRERELEASE) | (this.options.loose && FLAG_LOOSE)) + ":" + range;
			const cached = cache.get(memoKey);
			if (cached) return cached;
			const loose = this.options.loose;
			const hr = loose ? re[t.HYPHENRANGELOOSE] : re[t.HYPHENRANGE];
			range = range.replace(hr, hyphenReplace(this.options.includePrerelease));
			debug("hyphen replace", range);
			range = trimComparatorWhitespace(range);
			debug("comparator trim", range);
			range = range.replace(re[t.TILDETRIM], tildeTrimReplace);
			debug("tilde trim", range);
			range = range.replace(re[t.CARETTRIM], caretTrimReplace);
			debug("caret trim", range);
			let rangeList = range.split(" ").map((comp) => parseComparator(comp, this.options)).join(" ").split(/\s+/).map((comp) => replaceGTE0(comp, this.options));
			if (loose) rangeList = rangeList.filter((comp) => {
				debug("loose invalid filter", comp, this.options);
				return !!comp.match(re[t.COMPARATORLOOSE]);
			});
			debug("range list", rangeList);
			const rangeMap = /* @__PURE__ */ new Map();
			const comparators = rangeList.map((comp) => new Comparator(comp, this.options));
			for (const comp of comparators) {
				if (isNullSet(comp)) return [comp];
				rangeMap.set(comp.value, comp);
			}
			if (rangeMap.size > 1 && rangeMap.has("")) rangeMap.delete("");
			const result = [...rangeMap.values()];
			cache.set(memoKey, result);
			return result;
		}
		intersects(range, options) {
			if (!(range instanceof Range)) throw new TypeError("a Range is required");
			return this.set.some((thisComparators) => {
				return isSatisfiable(thisComparators, options) && range.set.some((rangeComparators) => {
					return isSatisfiable(rangeComparators, options) && thisComparators.every((thisComparator) => {
						return rangeComparators.every((rangeComparator) => {
							return thisComparator.intersects(rangeComparator, options);
						});
					});
				});
			});
		}
		test(version) {
			if (!version) return false;
			if (typeof version === "string") try {
				version = new SemVer(version, this.options);
			} catch (er) {
				return false;
			}
			for (let i = 0; i < this.set.length; i++) if (testSet(this.set[i], version, this.options)) return true;
			return false;
		}
	};
	module.exports = Range;
	const cache = new (require_lrucache())();
	const parseOptions = require_parse_options();
	const Comparator = require_comparator();
	const debug = require_debug();
	const SemVer = require_semver$1();
	const trimComparatorWhitespace = require_trim_comparator_whitespace();
	const { safeRe: re, src, t, tildeTrimReplace, caretTrimReplace } = require_re();
	const { FLAG_INCLUDE_PRERELEASE, FLAG_LOOSE } = require_constants();
	const BUILDSTRIPRE = new RegExp(src[t.BUILD], "g");
	const isNullSet = (c) => c.value === "<0.0.0-0";
	const isAny = (c) => c.value === "";
	const isSatisfiable = (comparators, options) => {
		let result = true;
		const remainingComparators = comparators.slice();
		let testComparator = remainingComparators.pop();
		while (result && remainingComparators.length) {
			result = remainingComparators.every((otherComparator) => {
				return testComparator.intersects(otherComparator, options);
			});
			testComparator = remainingComparators.pop();
		}
		return result;
	};
	const parseComparator = (comp, options) => {
		comp = comp.replace(re[t.BUILD], "");
		debug("comp", comp, options);
		comp = replaceCarets(comp, options);
		debug("caret", comp);
		comp = replaceTildes(comp, options);
		debug("tildes", comp);
		comp = replaceXRanges(comp, options);
		debug("xrange", comp);
		comp = replaceStars(comp, options);
		debug("stars", comp);
		return comp;
	};
	const isX = (id) => !id || id.toLowerCase() === "x" || id === "*";
	const invalidXRangeOrder = (M, m, p) => isX(M) && !isX(m) || isX(m) && p && !isX(p);
	const replaceTildes = (comp, options) => {
		return comp.trim().split(/\s+/).map((c) => replaceTilde(c, options)).join(" ");
	};
	const replaceTilde = (comp, options) => {
		const r = options.loose ? re[t.TILDELOOSE] : re[t.TILDE];
		const z = options.includePrerelease ? "-0" : "";
		return comp.replace(r, (_, M, m, p, pr) => {
			debug("tilde", comp, _, M, m, p, pr);
			let ret;
			if (isX(M)) ret = "";
			else if (isX(m)) ret = `>=${M}.0.0${z} <${+M + 1}.0.0-0`;
			else if (isX(p)) ret = `>=${M}.${m}.0${z} <${M}.${+m + 1}.0-0`;
			else if (pr) {
				debug("replaceTilde pr", pr);
				ret = `>=${M}.${m}.${p}-${pr} <${M}.${+m + 1}.0-0`;
			} else ret = `>=${M}.${m}.${p} <${M}.${+m + 1}.0-0`;
			debug("tilde return", ret);
			return ret;
		});
	};
	const replaceCarets = (comp, options) => {
		return comp.trim().split(/\s+/).map((c) => replaceCaret(c, options)).join(" ");
	};
	const replaceCaret = (comp, options) => {
		debug("caret", comp, options);
		const r = options.loose ? re[t.CARETLOOSE] : re[t.CARET];
		const z = options.includePrerelease ? "-0" : "";
		return comp.replace(r, (_, M, m, p, pr) => {
			debug("caret", comp, _, M, m, p, pr);
			let ret;
			if (isX(M)) ret = "";
			else if (isX(m)) ret = `>=${M}.0.0${z} <${+M + 1}.0.0-0`;
			else if (isX(p)) {
				if (M === "0") ret = `>=${M}.${m}.0${z} <${M}.${+m + 1}.0-0`;
				else ret = `>=${M}.${m}.0${z} <${+M + 1}.0.0-0`;
			} else if (pr) {
				debug("replaceCaret pr", pr);
				if (M === "0") {
					if (m === "0") ret = `>=${M}.${m}.${p}-${pr} <${M}.${m}.${+p + 1}-0`;
					else ret = `>=${M}.${m}.${p}-${pr} <${M}.${+m + 1}.0-0`;
				} else ret = `>=${M}.${m}.${p}-${pr} <${+M + 1}.0.0-0`;
			} else {
				debug("no pr");
				if (M === "0") {
					if (m === "0") ret = `>=${M}.${m}.${p} <${M}.${m}.${+p + 1}-0`;
					else ret = `>=${M}.${m}.${p} <${M}.${+m + 1}.0-0`;
				} else ret = `>=${M}.${m}.${p} <${+M + 1}.0.0-0`;
			}
			debug("caret return", ret);
			return ret;
		});
	};
	const replaceXRanges = (comp, options) => {
		debug("replaceXRanges", comp, options);
		return comp.split(/\s+/).map((c) => replaceXRange(c, options)).join(" ");
	};
	const replaceXRange = (comp, options) => {
		comp = comp.trim();
		const r = options.loose ? re[t.XRANGELOOSE] : re[t.XRANGE];
		return comp.replace(r, (ret, gtlt, M, m, p, pr) => {
			debug("xRange", comp, ret, gtlt, M, m, p, pr);
			if (invalidXRangeOrder(M, m, p)) return comp;
			const xM = isX(M);
			const xm = xM || isX(m);
			const xp = xm || isX(p);
			const anyX = xp;
			if (gtlt === "=" && anyX) gtlt = "";
			pr = options.includePrerelease ? "-0" : "";
			if (xM) {
				if (gtlt === ">" || gtlt === "<") ret = "<0.0.0-0";
				else ret = "*";
			} else if (gtlt && anyX) {
				if (xm) m = 0;
				p = 0;
				if (gtlt === ">") {
					gtlt = ">=";
					if (xm) {
						M = +M + 1;
						m = 0;
						p = 0;
					} else {
						m = +m + 1;
						p = 0;
					}
				} else if (gtlt === "<=") {
					gtlt = "<";
					if (xm) M = +M + 1;
					else m = +m + 1;
				}
				if (gtlt === "<") pr = "-0";
				ret = `${gtlt + M}.${m}.${p}${pr}`;
			} else if (xm) ret = `>=${M}.0.0${pr} <${+M + 1}.0.0-0`;
			else if (xp) ret = `>=${M}.${m}.0${pr} <${M}.${+m + 1}.0-0`;
			debug("xRange return", ret);
			return ret;
		});
	};
	const replaceStars = (comp, options) => {
		debug("replaceStars", comp, options);
		return comp.trim().replace(re[t.STAR], "");
	};
	const replaceGTE0 = (comp, options) => {
		debug("replaceGTE0", comp, options);
		return comp.trim().replace(re[options.includePrerelease ? t.GTE0PRE : t.GTE0], "");
	};
	const hyphenReplace = (incPr) => ($0, from, fM, fm, fp, fpr, fb, to, tM, tm, tp, tpr) => {
		if (isX(fM)) from = "";
		else if (isX(fm)) from = `>=${fM}.0.0${incPr ? "-0" : ""}`;
		else if (isX(fp)) from = `>=${fM}.${fm}.0${incPr ? "-0" : ""}`;
		else if (fpr) from = `>=${from}`;
		else from = `>=${from}${incPr ? "-0" : ""}`;
		if (isX(tM)) to = "";
		else if (isX(tm)) to = `<${+tM + 1}.0.0-0`;
		else if (isX(tp)) to = `<${tM}.${+tm + 1}.0-0`;
		else if (tpr) to = `<=${tM}.${tm}.${tp}-${tpr}`;
		else if (incPr) to = `<${tM}.${tm}.${+tp + 1}-0`;
		else to = `<=${to}`;
		return `${from} ${to}`.trim();
	};
	const testSet = (set, version, options) => {
		for (let i = 0; i < set.length; i++) if (!set[i].test(version)) return false;
		if (version.prerelease.length && !options.includePrerelease) {
			for (let i = 0; i < set.length; i++) {
				debug(set[i].semver);
				if (set[i].semver === Comparator.ANY) continue;
				if (set[i].semver.prerelease.length > 0) {
					const allowed = set[i].semver;
					if (allowed.major === version.major && allowed.minor === version.minor && allowed.patch === version.patch) return true;
				}
			}
			return false;
		}
		return true;
	};
}));

// node_modules/semver/classes/comparator.js
var require_comparator = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const ANY = Symbol("SemVer ANY");
	var Comparator = class Comparator {
		static get ANY() {
			return ANY;
		}
		constructor(comp, options) {
			options = parseOptions(options);
			if (comp instanceof Comparator) {
				if (comp.loose === !!options.loose) return comp;
				else comp = comp.value;
			}
			comp = comp.trim().split(/\s+/).join(" ");
			debug("comparator", comp, options);
			this.options = options;
			this.loose = !!options.loose;
			this.parse(comp);
			if (this.semver === ANY) this.value = "";
			else this.value = this.operator + this.semver.version;
			debug("comp", this);
		}
		parse(comp) {
			const r = this.options.loose ? re[t.COMPARATORLOOSE] : re[t.COMPARATOR];
			const m = comp.match(r);
			if (!m) throw new TypeError(`Invalid comparator: ${comp}`);
			this.operator = m[1] !== void 0 ? m[1] : "";
			if (this.operator === "=") this.operator = "";
			if (!m[2]) this.semver = ANY;
			else this.semver = new SemVer(m[2], this.options.loose);
		}
		toString() {
			return this.value;
		}
		test(version) {
			debug("Comparator.test", version, this.options.loose);
			if (this.semver === ANY || version === ANY) return true;
			if (typeof version === "string") try {
				version = new SemVer(version, this.options);
			} catch (er) {
				return false;
			}
			return cmp(version, this.operator, this.semver, this.options);
		}
		intersects(comp, options) {
			if (!(comp instanceof Comparator)) throw new TypeError("a Comparator is required");
			if (this.operator === "") {
				if (this.value === "") return true;
				return new Range(comp.value, options).test(this.value);
			} else if (comp.operator === "") {
				if (comp.value === "") return true;
				return new Range(this.value, options).test(comp.semver);
			}
			options = parseOptions(options);
			if (options.includePrerelease && (this.value === "<0.0.0-0" || comp.value === "<0.0.0-0")) return false;
			if (!options.includePrerelease && (this.value.startsWith("<0.0.0") || comp.value.startsWith("<0.0.0"))) return false;
			if (this.operator.startsWith(">") && comp.operator.startsWith(">")) return true;
			if (this.operator.startsWith("<") && comp.operator.startsWith("<")) return true;
			if (this.semver.version === comp.semver.version && this.operator.includes("=") && comp.operator.includes("=")) return true;
			if (cmp(this.semver, "<", comp.semver, options) && this.operator.startsWith(">") && comp.operator.startsWith("<")) return true;
			if (cmp(this.semver, ">", comp.semver, options) && this.operator.startsWith("<") && comp.operator.startsWith(">")) return true;
			return false;
		}
	};
	module.exports = Comparator;
	const parseOptions = require_parse_options();
	const { safeRe: re, t } = require_re();
	const cmp = require_cmp();
	const debug = require_debug();
	const SemVer = require_semver$1();
	const Range = require_range();
}));

// node_modules/semver/functions/satisfies.js
var require_satisfies = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const Range = require_range();
	const satisfies = (version, range, options) => {
		try {
			range = new Range(range, options);
		} catch (er) {
			return false;
		}
		return range.test(version);
	};
	module.exports = satisfies;
}));

// node_modules/semver/ranges/to-comparators.js
var require_to_comparators = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const Range = require_range();
	const toComparators = (range, options) => new Range(range, options).set.map((comp) => comp.map((c) => c.value).join(" ").trim().split(" "));
	module.exports = toComparators;
}));

// node_modules/semver/ranges/max-satisfying.js
var require_max_satisfying = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const SemVer = require_semver$1();
	const Range = require_range();
	const maxSatisfying = (versions, range, options) => {
		let max = null;
		let maxSV = null;
		let rangeObj = null;
		try {
			rangeObj = new Range(range, options);
		} catch (er) {
			return null;
		}
		versions.forEach((v) => {
			if (rangeObj.test(v)) {
				if (!max || maxSV.compare(v) === -1) {
					max = v;
					maxSV = new SemVer(max, options);
				}
			}
		});
		return max;
	};
	module.exports = maxSatisfying;
}));

// node_modules/semver/ranges/min-satisfying.js
var require_min_satisfying = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const SemVer = require_semver$1();
	const Range = require_range();
	const minSatisfying = (versions, range, options) => {
		let min = null;
		let minSV = null;
		let rangeObj = null;
		try {
			rangeObj = new Range(range, options);
		} catch (er) {
			return null;
		}
		versions.forEach((v) => {
			if (rangeObj.test(v)) {
				if (!min || minSV.compare(v) === 1) {
					min = v;
					minSV = new SemVer(min, options);
				}
			}
		});
		return min;
	};
	module.exports = minSatisfying;
}));

// node_modules/semver/ranges/min-version.js
var require_min_version = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const SemVer = require_semver$1();
	const Range = require_range();
	const gt = require_gt();
	const minVersion = (range, loose) => {
		range = new Range(range, loose);
		let minver = new SemVer("0.0.0");
		if (range.test(minver)) return minver;
		minver = new SemVer("0.0.0-0");
		if (range.test(minver)) return minver;
		minver = null;
		for (let i = 0; i < range.set.length; ++i) {
			const comparators = range.set[i];
			let setMin = null;
			comparators.forEach((comparator) => {
				const compver = new SemVer(comparator.semver.version);
				switch (comparator.operator) {
					case ">":
						if (compver.prerelease.length === 0) compver.patch++;
						else compver.prerelease.push(0);
						compver.raw = compver.format();
					case "":
					case ">=":
						if (!setMin || gt(compver, setMin)) setMin = compver;
						break;
					case "<":
					case "<=": break;
					/* istanbul ignore next */
					default: throw new Error(`Unexpected operation: ${comparator.operator}`);
				}
			});
			if (setMin && (!minver || gt(minver, setMin))) minver = setMin;
		}
		if (minver && range.test(minver)) return minver;
		return null;
	};
	module.exports = minVersion;
}));

// node_modules/semver/ranges/valid.js
var require_valid = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const Range = require_range();
	const validRange = (range, options) => {
		try {
			return new Range(range, options).range || "*";
		} catch (er) {
			return null;
		}
	};
	module.exports = validRange;
}));

// node_modules/semver/ranges/outside.js
var require_outside = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const SemVer = require_semver$1();
	const Comparator = require_comparator();
	const { ANY } = Comparator;
	const Range = require_range();
	const satisfies = require_satisfies();
	const gt = require_gt();
	const lt = require_lt();
	const lte = require_lte();
	const gte = require_gte();
	const outside = (version, range, hilo, options) => {
		version = new SemVer(version, options);
		range = new Range(range, options);
		let gtfn, ltefn, ltfn, comp, ecomp;
		switch (hilo) {
			case ">":
				gtfn = gt;
				ltefn = lte;
				ltfn = lt;
				comp = ">";
				ecomp = ">=";
				break;
			case "<":
				gtfn = lt;
				ltefn = gte;
				ltfn = gt;
				comp = "<";
				ecomp = "<=";
				break;
			default: throw new TypeError("Must provide a hilo val of \"<\" or \">\"");
		}
		if (satisfies(version, range, options)) return false;
		for (let i = 0; i < range.set.length; ++i) {
			const comparators = range.set[i];
			let high = null;
			let low = null;
			comparators.forEach((comparator) => {
				if (comparator.semver === ANY) comparator = new Comparator(">=0.0.0");
				high = high || comparator;
				low = low || comparator;
				if (gtfn(comparator.semver, high.semver, options)) high = comparator;
				else if (ltfn(comparator.semver, low.semver, options)) low = comparator;
			});
			if (high.operator === comp || high.operator === ecomp) return false;
			if ((!low.operator || low.operator === comp) && ltefn(version, low.semver)) return false;
			else if (low.operator === ecomp && ltfn(version, low.semver)) return false;
		}
		return true;
	};
	module.exports = outside;
}));

// node_modules/semver/ranges/gtr.js
var require_gtr = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const outside = require_outside();
	const gtr = (version, range, options) => outside(version, range, ">", options);
	module.exports = gtr;
}));

// node_modules/semver/ranges/ltr.js
var require_ltr = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const outside = require_outside();
	const ltr = (version, range, options) => outside(version, range, "<", options);
	module.exports = ltr;
}));

// node_modules/semver/ranges/intersects.js
var require_intersects = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const Range = require_range();
	const intersects = (r1, r2, options) => {
		r1 = new Range(r1, options);
		r2 = new Range(r2, options);
		return r1.intersects(r2, options);
	};
	module.exports = intersects;
}));

// node_modules/semver/ranges/simplify.js
var require_simplify = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const satisfies = require_satisfies();
	const compare = require_compare();
	module.exports = (versions, range, options) => {
		const set = [];
		let first = null;
		let prev = null;
		const v = versions.sort((a, b) => compare(a, b, options));
		for (const version of v) if (satisfies(version, range, options)) {
			prev = version;
			if (!first) first = version;
		} else {
			if (prev) set.push([first, prev]);
			prev = null;
			first = null;
		}
		if (first) set.push([first, null]);
		const ranges = [];
		for (const [min, max] of set) if (min === max) ranges.push(min);
		else if (!max && min === v[0]) ranges.push("*");
		else if (!max) ranges.push(`>=${min}`);
		else if (min === v[0]) ranges.push(`<=${max}`);
		else ranges.push(`${min} - ${max}`);
		const simplified = ranges.join(" || ");
		const original = typeof range.raw === "string" ? range.raw : String(range);
		return simplified.length < original.length ? simplified : range;
	};
}));

// node_modules/semver/ranges/subset.js
var require_subset = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const Range = require_range();
	const Comparator = require_comparator();
	const { ANY } = Comparator;
	const satisfies = require_satisfies();
	const compare = require_compare();
	const subset = (sub, dom, options = {}) => {
		if (sub === dom) return true;
		sub = new Range(sub, options);
		dom = new Range(dom, options);
		let sawNonNull = false;
		OUTER: for (const simpleSub of sub.set) {
			for (const simpleDom of dom.set) {
				const isSub = simpleSubset(simpleSub, simpleDom, options);
				sawNonNull = sawNonNull || isSub !== null;
				if (isSub) continue OUTER;
			}
			if (sawNonNull) return false;
		}
		return true;
	};
	const minimumVersionWithPreRelease = [new Comparator(">=0.0.0-0")];
	const minimumVersion = [new Comparator(">=0.0.0")];
	const simpleSubset = (sub, dom, options) => {
		if (sub === dom) return true;
		if (sub.length === 1 && sub[0].semver === ANY) {
			if (dom.length === 1 && dom[0].semver === ANY) return true;
			else if (options.includePrerelease) sub = minimumVersionWithPreRelease;
			else sub = minimumVersion;
		}
		if (dom.length === 1 && dom[0].semver === ANY) {
			if (options.includePrerelease) return true;
			else dom = minimumVersion;
		}
		const eqSet = /* @__PURE__ */ new Set();
		let gt, lt;
		for (const c of sub) if (c.operator === ">" || c.operator === ">=") gt = higherGT(gt, c, options);
		else if (c.operator === "<" || c.operator === "<=") lt = lowerLT(lt, c, options);
		else eqSet.add(c.semver);
		if (eqSet.size > 1) return null;
		let gtltComp;
		if (gt && lt) {
			gtltComp = compare(gt.semver, lt.semver, options);
			if (gtltComp > 0) return null;
			else if (gtltComp === 0 && (gt.operator !== ">=" || lt.operator !== "<=")) return null;
		}
		for (const eq of eqSet) {
			if (gt && !satisfies(eq, String(gt), options)) return null;
			if (lt && !satisfies(eq, String(lt), options)) return null;
			for (const c of dom) if (!satisfies(eq, String(c), options)) return false;
			return true;
		}
		let higher, lower;
		let hasDomLT, hasDomGT;
		let needDomLTPre = lt && !options.includePrerelease && lt.semver.prerelease.length ? lt.semver : false;
		let needDomGTPre = gt && !options.includePrerelease && gt.semver.prerelease.length ? gt.semver : false;
		if (needDomLTPre && needDomLTPre.prerelease.length === 1 && lt.operator === "<" && needDomLTPre.prerelease[0] === 0) needDomLTPre = false;
		for (const c of dom) {
			hasDomGT = hasDomGT || c.operator === ">" || c.operator === ">=";
			hasDomLT = hasDomLT || c.operator === "<" || c.operator === "<=";
			if (gt) {
				if (needDomGTPre) {
					if (c.semver.prerelease && c.semver.prerelease.length && c.semver.major === needDomGTPre.major && c.semver.minor === needDomGTPre.minor && c.semver.patch === needDomGTPre.patch) needDomGTPre = false;
				}
				if (c.operator === ">" || c.operator === ">=") {
					higher = higherGT(gt, c, options);
					if (higher === c && higher !== gt) return false;
				} else if (gt.operator === ">=" && !c.test(gt.semver)) return false;
			}
			if (lt) {
				if (needDomLTPre) {
					if (c.semver.prerelease && c.semver.prerelease.length && c.semver.major === needDomLTPre.major && c.semver.minor === needDomLTPre.minor && c.semver.patch === needDomLTPre.patch) needDomLTPre = false;
				}
				if (c.operator === "<" || c.operator === "<=") {
					lower = lowerLT(lt, c, options);
					if (lower === c && lower !== lt) return false;
				} else if (lt.operator === "<=" && !c.test(lt.semver)) return false;
			}
			if (!c.operator && (lt || gt) && gtltComp !== 0) return false;
		}
		if (gt && hasDomLT && !lt && gtltComp !== 0) return false;
		if (lt && hasDomGT && !gt && gtltComp !== 0) return false;
		if (needDomGTPre || needDomLTPre) return false;
		return true;
	};
	const higherGT = (a, b, options) => {
		if (!a) return b;
		const comp = compare(a.semver, b.semver, options);
		return comp > 0 ? a : comp < 0 ? b : b.operator === ">" && a.operator === ">=" ? b : a;
	};
	const lowerLT = (a, b, options) => {
		if (!a) return b;
		const comp = compare(a.semver, b.semver, options);
		return comp < 0 ? a : comp > 0 ? b : b.operator === "<" && a.operator === "<=" ? b : a;
	};
	module.exports = subset;
}));

// node_modules/semver/index.js
var require_semver = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const internalRe = require_re();
	const constants = require_constants();
	const SemVer = require_semver$1();
	const identifiers = require_identifiers();
	const parse = require_parse();
	const valid = require_valid$1();
	const clean = require_clean();
	const inc = require_inc();
	const diff = require_diff();
	const major = require_major();
	const minor = require_minor();
	const patch = require_patch();
	const prerelease = require_prerelease();
	const compare = require_compare();
	const rcompare = require_rcompare();
	const compareLoose = require_compare_loose();
	const compareBuild = require_compare_build();
	const sort = require_sort();
	const rsort = require_rsort();
	const gt = require_gt();
	const lt = require_lt();
	const eq = require_eq();
	const neq = require_neq();
	const gte = require_gte();
	const lte = require_lte();
	const cmp = require_cmp();
	const coerce = require_coerce();
	const truncate = require_truncate();
	const Comparator = require_comparator();
	const Range = require_range();
	const satisfies = require_satisfies();
	const toComparators = require_to_comparators();
	const maxSatisfying = require_max_satisfying();
	const minSatisfying = require_min_satisfying();
	const minVersion = require_min_version();
	const validRange = require_valid();
	const outside = require_outside();
	const gtr = require_gtr();
	const ltr = require_ltr();
	const intersects = require_intersects();
	const simplifyRange = require_simplify();
	const subset = require_subset();
	module.exports = {
		parse,
		valid,
		clean,
		inc,
		diff,
		major,
		minor,
		patch,
		prerelease,
		compare,
		rcompare,
		compareLoose,
		compareBuild,
		sort,
		rsort,
		gt,
		lt,
		eq,
		neq,
		gte,
		lte,
		cmp,
		coerce,
		truncate,
		Comparator,
		Range,
		satisfies,
		toComparators,
		maxSatisfying,
		minSatisfying,
		minVersion,
		validRange,
		outside,
		gtr,
		ltr,
		intersects,
		simplifyRange,
		subset,
		SemVer,
		re: internalRe.re,
		src: internalRe.src,
		tokens: internalRe.t,
		SEMVER_SPEC_VERSION: constants.SEMVER_SPEC_VERSION,
		RELEASE_TYPES: constants.RELEASE_TYPES,
		compareIdentifiers: identifiers.compareIdentifiers,
		rcompareIdentifiers: identifiers.rcompareIdentifiers
	};
}));

// node_modules/@renovatebot/pep440/lib/version.js
var import_semver = require_semver();
const VERSION_PATTERN = [
	"v?",
	"(?:",
	"(?:(?<epoch>[0-9]+)!)?",
	"(?<release>[0-9]+(?:\\.[0-9]+)*)",
	"(?<pre>",
	"[-_\\.]?",
	"(?<pre_l>(a|b|c|rc|alpha|beta|pre|preview))",
	"[-_\\.]?",
	"(?<pre_n>[0-9]+)?",
	")?",
	"(?<post>",
	"(?:-(?<post_n1>[0-9]+))",
	"|",
	"(?:",
	"[-_\\.]?",
	"(?<post_l>post|rev|r)",
	"[-_\\.]?",
	"(?<post_n2>[0-9]+)?",
	")",
	")?",
	"(?<dev>",
	"[-_\\.]?",
	"(?<dev_l>dev)",
	"[-_\\.]?",
	"(?<dev_n>[0-9]+)?",
	")?",
	")",
	"(?:\\+(?<local>[a-z0-9]+(?:[-_\\.][a-z0-9]+)*))?"
].join("");
const validRegex = new RegExp("^" + VERSION_PATTERN + "$", "i");
function valid(version) {
	return validRegex.test(version) ? version : null;
}
const cleanRegex = new RegExp("^\\s*" + VERSION_PATTERN + "\\s*$", "i");
function parse$1(version, regex) {
	const { groups } = (regex || validRegex).exec(version) || {};
	if (!groups) return null;
	return {
		epoch: Number(groups.epoch ? groups.epoch : 0),
		release: groups.release.split(".").map(Number),
		pre: normalize_letter_version(groups.pre_l, groups.pre_n),
		post: normalize_letter_version(groups.post_l, groups.post_n1 || groups.post_n2),
		dev: normalize_letter_version(groups.dev_l, groups.dev_n),
		local: parse_local_version(groups.local)
	};
}
function normalize_letter_version(letterIn, numberIn) {
	let letter = letterIn;
	let number = numberIn;
	if (letter) {
		if (!number) number = 0;
		letter = letter.toLowerCase();
		if (letter === "alpha") letter = "a";
		else if (letter === "beta") letter = "b";
		else if ([
			"c",
			"pre",
			"preview"
		].includes(letter)) letter = "rc";
		else if (["rev", "r"].includes(letter)) letter = "post";
		return [letter, Number(number)];
	}
	if (!letter && number) {
		letter = "post";
		return [letter, Number(number)];
	}
	return null;
}
function parse_local_version(local) {
	if (local) return local.split(/[._-]/).map((part) => Number.isNaN(Number(part)) ? part.toLowerCase() : Number(part));
	return null;
}

// node_modules/@renovatebot/pep440/lib/operator.js
function compare(version, other) {
	const parsedVersion = parse$1(version);
	const parsedOther = parse$1(other);
	return pyCompare(calculateKey(parsedVersion), calculateKey(parsedOther));
}
function pyCompare(elemIn, otherIn) {
	let elem = elemIn;
	let other = otherIn;
	if (elem === other) return 0;
	if (Array.isArray(elem) !== Array.isArray(other)) {
		elem = Array.isArray(elem) ? elem : [elem];
		other = Array.isArray(other) ? other : [other];
	}
	if (Array.isArray(elem)) {
		const len = Math.min(elem.length, other.length);
		for (let i = 0; i < len; i += 1) {
			const res = pyCompare(elem[i], other[i]);
			if (res !== 0) return res;
		}
		return elem.length - other.length;
	}
	if (elem === -Infinity || other === Infinity) return -1;
	if (elem === Infinity || other === -Infinity) return 1;
	return elem < other ? -1 : 1;
}
function calculateKey(input) {
	const { epoch } = input;
	let { release, pre, post, local, dev } = input;
	release = release.concat();
	release.reverse();
	while (release.length && release[0] === 0) release.shift();
	release.reverse();
	if (!pre && !post && dev) pre = -Infinity;
	else if (!pre) pre = Infinity;
	if (!post) post = -Infinity;
	if (!dev) dev = Infinity;
	if (!local) local = -Infinity;
	else local = local.map((i) => Number.isNaN(Number(i)) ? [-Infinity, i] : [Number(i), ""]);
	return [
		epoch,
		release,
		pre,
		post,
		dev,
		local
	];
}

// node_modules/@renovatebot/pep440/lib/specifier.js
const RANGE_PATTERN = [
	"(?<operator>(===|~=|==|!=|<=|>=|<|>))",
	"\\s*",
	"(",
	"(?<version>(?:" + VERSION_PATTERN.replace(/\?<\w+>/g, "?:") + "))",
	"(?<prefix>\\.\\*)?",
	"|",
	"(?<legacy>[^,;\\s)]+)",
	")"
].join("");
const rangeRegex = new RegExp("^" + RANGE_PATTERN + "$", "i");

// src/evidence/upstream-version.ts
/** Ordering never rewrites inventory identity; equal precedence is not a version mapping. */
function compareUpstreamVersions(ecosystem, left, right) {
	if (!upstreamText(left) || !upstreamText(right) || /\s/u.test(left + right)) return null;
	const values = [left, right];
	if (ecosystem === "npm") {
		if (!values.every((v) => /^\d/u.test(v) && (0, import_semver.valid)(v) !== null)) return null;
		return Math.sign((0, import_semver.compare)(left, right));
	}
	if (!values.every((v) => valid(v) !== null)) return null;
	return Math.sign(compare(left, right));
}

// src/evidence/policy-signals-licenses.ts
function terms(node, operator) {
	return "conjunction" in node && node.conjunction === operator ? [...terms(node.left, operator), ...terms(node.right, operator)] : [node];
}
function serialize(node) {
	if ("license" in node) return node.license + (node.plus ? "+" : "") + (node.exception ? " WITH " + node.exception : "");
	return "(" + terms(node, node.conjunction).map(serialize).join(" " + node.conjunction.toUpperCase() + " ") + ")";
}
function canonicalLicense(value, limits) {
	return observe(() => {
		if (value === null) return null;
		advisoryCheck(typeof value === "string");
		advisoryCheck(Buffer.byteLength(value) <= limits.maxBytes, "budget");
		const tokens = value.match(/[()]|[^()\s]+/gu) ?? [];
		advisoryCheck(tokens.length <= limits.maxTokens, "budget");
		let depth = 0;
		for (const t of tokens) if (t === "(") advisoryCheck(++depth <= limits.maxDepth, "budget");
		else if (t === ")") advisoryCheck(--depth >= 0);
		advisoryCheck(depth === 0);
		return serialize((0, import_spdx_expression_parse.default)(value.trim()));
	});
}

// src/budget.ts
const MiB = 1048576;
/** Bounds for all pre-analysis evidence reads. Time is shared; every reader gets what remains. */
const W2_ENVELOPE = Object.freeze({
	maxRequests: 512,
	maxResponseBytes: MiB,
	maxTotalBytes: 32 * MiB,
	requestTimeoutMs: 15e3,
	totalTimeoutMs: 24e4
});
/**
* How the envelope is divided between readers. A larger pull request exhausts a share and ends
* incomplete with a `budget` reason; no reader borrows from another.
*/
const W2_ALLOCATION = Object.freeze({
	transport: Object.freeze({
		maxRequests: 64,
		maxTotalBytes: 4 * MiB
	}),
	session: Object.freeze({
		maxRequests: 160,
		maxTotalBytes: 12 * MiB
	}),
	registry: Object.freeze({
		maxRequests: 64,
		maxTotalBytes: 4 * MiB
	}),
	upstream: Object.freeze({
		maxRequests: 96,
		maxTotalBytes: 6 * MiB
	}),
	advisory: Object.freeze({
		maxRequests: 64,
		maxTotalBytes: 4 * MiB
	}),
	signals: Object.freeze({
		maxRequests: 64,
		maxTotalBytes: 2 * MiB
	})
});

// src/runtime.ts
const W2_GITHUB_LIMITS = Object.freeze({
	maxRequests: W2_ALLOCATION.transport.maxRequests,
	maxResponseBytes: W2_ENVELOPE.maxResponseBytes,
	maxTotalBytes: W2_ALLOCATION.transport.maxTotalBytes,
	requestTimeoutMs: W2_ENVELOPE.requestTimeoutMs,
	totalTimeoutMs: W2_ENVELOPE.totalTimeoutMs
});
function plainText(value) {
	return typeof value === "string" && value.length > 0 && !Array.from(value).some((character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127;
	});
}
function repository(value, id) {
	if (!plainText(value) || !plainText(id)) return null;
	const pieces = value.split("/");
	const numericId = Number(id);
	if (pieces.length !== 2 || !pieces.every((piece) => plainText(piece) && !/[\s/]/u.test(piece)) || !positiveId(numericId) || !/^\d+$/u.test(id)) return null;
	return Object.freeze({
		id: numericId,
		owner: pieces[0],
		name: pieces[1]
	});
}
function workflow(value) {
	if (!plainText(value)) return null;
	const match = /^\.github\/workflows\/([^/]+\.(?:ya?ml))$/u.exec(value);
	if (!match || !plainText(match[1])) return null;
	return Object.freeze({
		path: value,
		file: match[1]
	});
}
function parseRuntime(value) {
	const githubToken = value.INPUT_GITHUB_TOKEN;
	const appToken = value.INPUT_APP_TOKEN;
	const repo = repository(value.GITHUB_REPOSITORY, value.GITHUB_REPOSITORY_ID);
	const selectedWorkflow = workflow(value.INPUT_CI_WORKFLOW);
	if (!plainText(githubToken) || !plainText(appToken) || !repo || !selectedWorkflow) return null;
	const llmApiKey = plainText(value.INPUT_LLM_API_KEY) ? value.INPUT_LLM_API_KEY : null;
	return Object.freeze({
		githubToken,
		appToken,
		llmApiKey,
		repository: repo,
		workflowPath: selectedWorkflow.path,
		workflowFile: selectedWorkflow.file
	});
}

// src/startup.ts
/** Distinct from 1, which Node uses when the bundle itself fails to load. */
const NOT_WIRED_EXIT_CODE = 78;
const SELF_CHECK_EXIT_CODE = 79;
const bundledModules = { createNpmPublishTimeReader };
const bytes = (text) => new TextEncoder().encode(text);
async function streamJsonParses() {
	const names = [];
	const stream = parser_default.asStream({
		packValues: false,
		streamValues: true,
		jsonStreaming: false
	});
	stream.on("data", (token) => names.push(token.name));
	await new Promise((resolve, reject) => {
		stream.on("end", resolve);
		stream.on("error", reject);
		stream.end("{\"a\":1}");
	});
	return names.includes("startObject") && typeof bundledModules.createNpmPublishTimeReader === "function";
}
/** Runs each production dependency once, with no network, secret, or filesystem access. */
async function selfCheck() {
	const toml = readToml(bytes("a = 1"), {
		maxFileBytes: 64,
		maxTomlDepth: 4,
		maxTomlEntries: 8,
		maxPackages: 1,
		maxDeclarations: 1,
		maxEdges: 1,
		maxStringBytes: 16,
		maxRequirementTokens: 4,
		maxMarkerDepth: 2
	});
	const workflow = readWorkflow(bytes("jobs:\n  a:\n    steps:\n      - uses: ./local\n"), {
		maxFileBytes: 256,
		maxYamlNodes: 64,
		maxYamlDepth: 8,
		maxAliasExpansions: 0,
		maxOccurrences: 4
	});
	const license = canonicalLicense("MIT", {
		maxBytes: 32,
		maxTokens: 4,
		maxDepth: 2
	});
	return {
		semver: compareUpstreamVersions("npm", "1.0.0", "1.0.1") === -1,
		pep440: compareUpstreamVersions("uv", "1.0", "1.1") === -1,
		spdx: license.kind === "known" && license.value === "MIT",
		toml: toml.kind === "parsed",
		yaml: workflow.kind === "parsed",
		streamJson: await streamJsonParses()
	};
}
/** The W2 action validates startup inputs but intentionally has no production claim or write adapter. */
async function runStartup(writeError, environment = process.env) {
	if (!await selfCheck().then((checks) => Object.values(checks).every(Boolean), () => false)) {
		writeError("dependabot-review: startup self-check failed; no review ran.");
		return 79;
	}
	if (!parseRuntime(environment)) {
		writeError("dependabot-review: runtime configuration invalid; no review ran.");
		return 78;
	}
	writeError("dependabot-review: no-write rehearsal completed; no review ran.");
	return 78;
}

// src/index.ts
process.exitCode = await runStartup((line) => process.stderr.write(`${line}\n`));

export {  };