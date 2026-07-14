/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import path from 'node:path'
import { defineConfig } from 'tsup'

const entryPoints = [
	'./src2/orbit-editor-widgets-tsx/index.tsx',
	'./src2/sidebar-tsx/index.tsx',
	'./src2/chathistory-tsx/index.tsx',
	'./src2/orbit-settings-tsx/index.tsx',
	'./src2/customize-tsx/index.tsx',
	'./src2/orbit-tooltip/index.tsx',
	'./src2/orbit-onboarding/index.tsx',
	'./src2/quick-edit-tsx/index.tsx',
	'./src2/diff/index.tsx',
	'./src2/plan-editor-tsx/index.tsx',
	'./src2/history-dropdown-tsx/index.tsx',
	'./src2/vibe-sidebar-tsx/index.tsx',
	'./src2/agent-window-tsx/index.tsx',
]
const entryDirs = new Set(entryPoints.map((entry) => path.basename(path.dirname(entry))))
const src2Root = path.resolve(__dirname, 'src2')

const externalizeOutsideSrc2 = {
	name: 'externalize-outside-src2',
	setup(build) {
		build.onResolve({ filter: /^\./ }, async (args) => {
			if (args.pluginData?.skipExternalize) {
				return null
			}

			const result = await build.resolve(args.path, {
				resolveDir: args.resolveDir,
				kind: args.kind,
				pluginData: { skipExternalize: true },
			})
			if (result.errors.length || !result.path) {
				return null
			}

			const resolved = result.path
			const normalized = path.normalize(resolved)
			const src2Prefix = src2Root + path.sep

			if (normalized.includes(`${path.sep}node_modules${path.sep}`)) {
				return null
			}

			if (normalized.startsWith(src2Prefix)) {
				return null
			}

			const resolvedForSpec = resolved.replace(/\.(mts|ts|tsx)$/, '.js')
			const importerPath = args.importer ? path.resolve(args.importer) : args.resolveDir
			let entryDir = 'sidebar-tsx'
			if (importerPath.startsWith(src2Prefix)) {
				const candidate = path.relative(src2Root, importerPath).split(path.sep)[0]
				if (candidate && entryDirs.has(candidate)) {
					entryDir = candidate
				}
			}
			const entryBase = path.join(src2Root, entryDir)
			const rel = path.relative(entryBase, resolvedForSpec).replace(/\\\\/g, '/')
			const relSpec = rel.startsWith('.') ? rel : `./${rel}`

			return { path: relSpec, external: true }
		})
	}
}

export default defineConfig({
	entry: entryPoints,
	outDir: './out',
	format: ['esm'],
	splitting: false,

	// dts: true,
	// sourcemap: true,

	clean: false,
	platform: 'browser', // 'node'
	target: 'esnext',
	injectStyle: true, // bundle css into the output file
	outExtension: () => ({ js: '.js' }),
	// default behavior is to take local files and make them internal (bundle them) and take imports like 'react' and leave them external (don't bundle them), we want the opposite in many ways
	noExternal: [ // Bundle npm packages
		/^(?!\.).*$/
	],
	treeshake: true,
	esbuildPlugins: [externalizeOutsideSrc2],
	esbuildOptions(options) {
		options.outbase = 'src2'  // tries copying the folder hierarchy starting at src2
	}
})
