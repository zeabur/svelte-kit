import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeFileTrace } from '@vercel/nft';

const name = '@zeabur/svelte-adapter';
const DEFAULT_FUNCTION_NAME = '__svelte';

const get_default_runtime = () => {
	const major = process.version.slice(1).split('.')[0];
	if (major === '18') return 'nodejs18.x';
	if (major === '20') return 'nodejs20.x';

	throw new Error(
		`Unsupported Node.js version: ${process.version}. Please use Node 18 or Node 20 to build your project, or explicitly specify a runtime in your adapter configuration.`
	);
};

/** @type {import('.').default} **/
const plugin = function (defaults = {}) {
	return {
		name,

		async adapt(builder) {
			const dir = '.zeabur/output';
			const tmp = builder.getBuildDirectory('zeabur');

			builder.rimraf(dir);
			builder.rimraf(tmp);

			const files = fileURLToPath(new URL('./files', import.meta.url).href);

			const dirs = {
				static: `${dir}/static${builder.config.kit.paths.base}`,
				functions: `${dir}/functions`
			};

			builder.log.minor('Generating serverless function...');

			/**
			 * @param {string} name
			 * @param {import('@sveltejs/kit').RouteDefinition<import('.').Config>[]} routes
			 */
			async function generate_serverless_function(name, routes) {
				const dir = `${dirs.functions}/${name}.func`;

				const relativePath = path.posix.relative(tmp, builder.getServerDirectory());

				builder.copy(`${files}/serverless.js`, `${tmp}/index.js`, {
					replace: {
						SERVER: `${relativePath}/index.js`,
						MANIFEST: './manifest.js'
					}
				});

				write(
					`${tmp}/manifest.js`,
					`export const manifest = ${builder.generateManifest({ relativePath, routes })};\n`
				);

				await create_function_bundle(builder, `${tmp}/index.js`, dir);

				for (const asset of builder.findServerAssets(routes)) {
					// TODO use symlinks, once Build Output API supports doing so
					builder.copy(`${builder.getServerDirectory()}/${asset}`, `${dir}/${asset}`);
				}
			}

			/** @type {Map<string, { i: number, config: import('.').Config, routes: import('@sveltejs/kit').RouteDefinition<import('.').Config>[] }>} */
			const groups = new Map();

			/** @type {Map<string, { hash: string, route_id: string }>} */
			const conflicts = new Map();

			/** @type {Map<string, string>} */
			const functions = new Map();

			/** @type {Map<import('@sveltejs/kit').RouteDefinition<import('.').Config>, { expiration: number | false, bypassToken: string | undefined, allowQuery: string[], group: number, passQuery: true }>} */
			const isr_config = new Map();

			/** @type {Set<string>} */
			const ignored_isr = new Set();

			// group routes by config
			for (const route of builder.routes) {
				const runtime = route.config?.runtime ?? defaults?.runtime ?? get_default_runtime();
				const config = { runtime, ...defaults, ...route.config };

				if (is_prerendered(route)) {
					if (config.isr) {
						ignored_isr.add(route.id);
					}
					continue;
				}

				if (config.isr) {
					const directory = path.relative('.', builder.config.kit.files.routes + route.id);

					if (!runtime.startsWith('nodejs')) {
						throw new Error(
							`${directory}: Routes using \`isr\` must use a Node.js runtime (for example 'nodejs20.x')`
						);
					}

					if (config.isr.allowQuery?.includes('__pathname')) {
						throw new Error(
							`${directory}: \`__pathname\` is a reserved query parameter for \`isr.allowQuery\``
						);
					}

					isr_config.set(route, {
						expiration: config.isr.expiration,
						bypassToken: config.isr.bypassToken,
						allowQuery: ['__pathname', ...(config.isr.allowQuery ?? [])],
						group: isr_config.size + 1,
						passQuery: true
					});
				}

				const hash = hash_config(config);

				// first, check there are no routes with incompatible configs that will be merged
				const pattern = route.pattern.toString();
				const existing = conflicts.get(pattern);
				if (existing) {
					if (existing.hash !== hash) {
						throw new Error(
							`The ${route.id} and ${existing.route_id} routes must be merged into a single function that matches the ${route.pattern} regex, but they have incompatible configs. You must either rename one of the routes, or make their configs match.`
						);
					}
				} else {
					conflicts.set(pattern, { hash, route_id: route.id });
				}

				// then, create a group for each config
				const id = config.split ? `${hash}-${groups.size}` : hash;
				let group = groups.get(id);
				if (!group) {
					group = { i: groups.size, config, routes: [] };
					groups.set(id, group);
				}

				group.routes.push(route);
			}

			if (ignored_isr.size) {
				builder.log.warn(
					'\nWarning: The following routes have an ISR config which is ignored because the route is prerendered:'
				);

				for (const ignored of ignored_isr) {
					console.log(`    - ${ignored}`);
				}

				console.log(
					'Either remove the "prerender" option from these routes to use ISR, or remove the ISR config.\n'
				);
			}

			const singular = groups.size === 1;

			for (const group of groups.values()) {

				// generate one function for the group
				const name = singular ? DEFAULT_FUNCTION_NAME : `fn-${group.i}`;

				await generate_serverless_function(
					name,
					/** @type {import('@sveltejs/kit').RouteDefinition<any>[]} */ (group.routes)
				);

				for (const route of group.routes) {
					functions.set(route.pattern.toString(), name);
				}
			}

			if (!singular) {
				await generate_serverless_function(
					DEFAULT_FUNCTION_NAME,
					[]
				);
			}

			builder.log.minor('Copying assets...');

			builder.writeClient(dirs.static);
			builder.writePrerendered(dirs.static);

			builder.log.minor('Writing routes...');

			write(`${dir}/config.json`, JSON.stringify({ routes: [{ src: '.*', dest: '/__svelte' }], containerized: false }, null, '\t'));
		},
	};
};

/** @param {import('.').EdgeConfig & import('.').ServerlessConfig} config */
function hash_config(config) {
	return [
		config.runtime ?? '',
		config.external ?? '',
		config.regions ?? '',
		config.memory ?? '',
		config.maxDuration ?? '',
		!!config.isr // need to distinguish ISR from non-ISR functions, because ISR functions can't use streaming mode
	].join('/');
}

/**
 * @param {string} file
 * @param {string} data
 */
function write(file, data) {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
	} catch {
		// do nothing
	}

	fs.writeFileSync(file, data);
}

/**
 * @param {import('@sveltejs/kit').Builder} builder
 * @param {string} entry
 * @param {string} dir
 */
async function create_function_bundle(builder, entry, dir) {
	fs.rmSync(dir, { force: true, recursive: true });

	let base = entry;
	while (base !== (base = path.dirname(base)));

	const traced = await nodeFileTrace([entry], { base });

	/** @type {Map<string, string[]>} */
	const resolution_failures = new Map();

	traced.warnings.forEach((error) => {
		// pending https://github.com/vercel/nft/issues/284
		if (error.message.startsWith('Failed to resolve dependency node:')) return;

		// parse errors are likely not js and can safely be ignored,
		// such as this html file in "main" meant for nw instead of node:
		// https://github.com/vercel/nft/issues/311
		if (error.message.startsWith('Failed to parse')) return;

		if (error.message.startsWith('Failed to resolve dependency')) {
			const match = /Cannot find module '(.+?)' loaded from (.+)/;
			const [, module, importer] = match.exec(error.message) ?? [, error.message, '(unknown)'];

			if (!resolution_failures.has(importer)) {
				resolution_failures.set(importer, []);
			}

			/** @type {string[]} */ (resolution_failures.get(importer)).push(module);
		} else {
			throw error;
		}
	});

	if (resolution_failures.size > 0) {
		const cwd = process.cwd();
		builder.log.warn(
			'Warning: The following modules failed to locate dependencies that may (or may not) be required for your app to work:'
		);

		for (const [importer, modules] of resolution_failures) {
			console.error(`  ${path.relative(cwd, importer)}`);
			for (const module of modules) {
				console.error(`    - \u001B[1m\u001B[36m${module}\u001B[39m\u001B[22m`);
			}
		}
	}

	const files = Array.from(traced.fileList);

	// find common ancestor directory
	/** @type {string[]} */
	let common_parts = files[0]?.split(path.sep) ?? [];

	for (let i = 1; i < files.length; i += 1) {
		const file = files[i];
		const parts = file.split(path.sep);

		for (let j = 0; j < common_parts.length; j += 1) {
			if (parts[j] !== common_parts[j]) {
				common_parts = common_parts.slice(0, j);
				break;
			}
		}
	}

	const ancestor = base + common_parts.join(path.sep);

	for (const file of traced.fileList) {
		const source = base + file;
		const dest = path.join(dir, path.relative(ancestor, source));

		const stats = fs.statSync(source);
		const is_dir = stats.isDirectory();

		const realpath = fs.realpathSync(source);

		try {
			fs.mkdirSync(path.dirname(dest), { recursive: true });
		} catch {
			// do nothing
		}

		if (source !== realpath) {
			const realdest = path.join(dir, path.relative(ancestor, realpath));
			fs.symlinkSync(path.relative(path.dirname(dest), realdest), dest, is_dir ? 'dir' : 'file');
		} else if (!is_dir) {
			fs.copyFileSync(source, dest);
		}
	}

	write(`${dir}/index.mjs`, 'export { default } from "./.svelte-kit/zeabur/index.js";');

	write(`${dir}/package.json`, JSON.stringify({ type: 'module' }));
}

/** @param {import('@sveltejs/kit').RouteDefinition} route */
function is_prerendered(route) {
	return (
		route.prerender === true ||
		(route.prerender === 'auto' && route.segments.every((segment) => !segment.dynamic))
	);
}

export default plugin;
