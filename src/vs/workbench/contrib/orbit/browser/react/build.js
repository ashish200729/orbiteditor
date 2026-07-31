/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Orbit Editor. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { execSync } from 'child_process';
import { spawn } from 'cross-spawn'
// Added lines below
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizeEsModuleImportPaths(text) {
	return text
		.replace(/(from\s*['"])([^'"]+)(['"])/g, (_, pre, p, post) => pre + p.replace(/\\/g, '/').replace(/\/{2,}/g, '/') + post)
		.replace(/(import\s*['"])([^'"]+)(['"])/g, (_, pre, p, post) => pre + p.replace(/\\/g, '/').replace(/\/{2,}/g, '/') + post)
		.replace(/(import\s*\(\s*['"])([^'"]+)(['"]\s*\))/g, (_, pre, p, post) => pre + p.replace(/\\/g, '/').replace(/\/{2,}/g, '/') + post);
}

function normalizeImportPathsInOutDir(outDir = path.join(__dirname, 'out')) {
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.name.endsWith('.js')) {
				const original = fs.readFileSync(fullPath, 'utf8');
				const normalized = normalizeEsModuleImportPaths(original);
				if (normalized !== original) {
					fs.writeFileSync(fullPath, normalized, 'utf8');
				}
			}
		}
	};

	if (fs.existsSync(outDir)) {
		walk(outDir);
	}
}

function getOrderedExportNames(fileContents, pattern) {
	return [...fileContents.matchAll(pattern)].map(match => match[1]);
}

function getNamedExportNames(fileContents) {
	const names = [];
	for (const match of fileContents.matchAll(/export\s*\{([^}]+)\}/g)) {
		for (const part of match[1].split(',')) {
			const trimmed = part.trim();
			if (!trimmed) {
				continue;
			}
			const aliasMatch = trimmed.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
			if (aliasMatch) {
				names.push(aliasMatch[2] ?? aliasMatch[1]);
			}
		}
	}
	return names;
}

function resolveBarrelImport(importPath, specifiers, outBuildVs, outVs) {
	if (!importPath.endsWith('platform/theme/common/colorRegistry.js')) {
		return undefined;
	}

	const colorFiles = [
		'platform/theme/common/colors/inputColors.js',
		'platform/theme/common/colors/baseColors.js',
		'platform/theme/common/colors/editorColors.js',
	];
	const parts = specifiers.split(',').map(part => part.trim()).filter(Boolean);
	const resolvedFiles = new Set();

	for (const part of parts) {
		const importedName = part.split(/\s+as\s+/)[0].trim();
		let found = false;
		for (const colorFile of colorFiles) {
			const unmangledPath = path.join(outVs, colorFile);
			const mangledPath = path.join(outBuildVs, colorFile);
			if (!pathExists(unmangledPath) || !pathExists(mangledPath)) {
				continue;
			}
			const nameMap = buildExportRenameMap(
				fs.readFileSync(unmangledPath, 'utf8'),
				fs.readFileSync(mangledPath, 'utf8'),
			);
			if (nameMap.has(importedName)) {
				resolvedFiles.add(colorFile);
				found = true;
				break;
			}
		}
		if (!found) {
			return undefined;
		}
	}

	if (resolvedFiles.size !== 1) {
		return undefined;
	}

	return [...resolvedFiles][0];
}

function buildExportRenameMap(unmangledContents, mangledContents) {
	const map = new Map();

	const constPattern = /export const ([A-Za-z_$][\w$]*)\s*=/g;
	const functionPattern = /export (?:async )?function ([A-Za-z_$][\w$]*)/g;
	const varPattern = /export var ([A-Za-z_$][\w$]*)/g;
	const classPattern = /export class ([A-Za-z_$][\w$]*)/g;
	const namedExportPattern = /export\s*\{([^}]+)\}/g;

	const exportGroups = [
		[getOrderedExportNames(unmangledContents, constPattern), getOrderedExportNames(mangledContents, constPattern)],
		[getOrderedExportNames(unmangledContents, functionPattern), getOrderedExportNames(mangledContents, functionPattern)],
		[getOrderedExportNames(unmangledContents, varPattern), getOrderedExportNames(mangledContents, varPattern)],
		[getOrderedExportNames(unmangledContents, classPattern), getOrderedExportNames(mangledContents, classPattern)],
		[getNamedExportNames(unmangledContents), getNamedExportNames(mangledContents)],
	];

	for (const [unmangledNames, mangledNames] of exportGroups) {
		if (unmangledNames.length === 0 || unmangledNames.length !== mangledNames.length) {
			continue;
		}
		unmangledNames.forEach((name, index) => map.set(name, mangledNames[index]));
	}

	return map;
}

function pathExists(filePath) {
	try {
		fs.statSync(filePath);
		return true;
	} catch (err) {
		if (err.code === 'ENOENT') {
			return false;
		}
		throw err;
	}
}

function adaptReactOutForMangledBuild(outDir = path.join(__dirname, 'out')) {
	let outBuildVs;
	let outVs;
	let currentPath = __dirname;
	while (true) {
		const candidateOutBuild = path.join(currentPath, 'out-build', 'vs');
		const candidateOut = path.join(currentPath, 'out', 'vs');
		if (pathExists(candidateOutBuild) && pathExists(candidateOut)) {
			outBuildVs = candidateOutBuild;
			outVs = candidateOut;
			break;
		}
		const parentDir = path.dirname(currentPath);
		if (parentDir === currentPath) {
			break;
		}
		currentPath = parentDir;
	}

	if (!outBuildVs || !outVs) {
		console.log('[buildreact] Skipping mangled import rewrite (out-build/vs or out/vs not found)');
		return;
	}

	const importPattern = /import\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g;

	const rewriteFile = (filePath) => {
		let contents = fs.readFileSync(filePath, 'utf8');
		let changed = false;
		const relativeInReactOut = path.relative(outDir, filePath).replace(/\\/g, '/');
		const virtualFilePath = path.join(outBuildVs, 'workbench', 'contrib', 'orbit', 'browser', 'react', 'out', relativeInReactOut);

		contents = contents.replace(importPattern, (full, specifiers, quote, importPath) => {
			if (!importPath.startsWith('.')) {
				return full;
			}

			const resolved = path.normalize(path.join(path.dirname(virtualFilePath), importPath));
			const relativeToVs = path.relative(outBuildVs, resolved).replace(/\\/g, '/');
			if (relativeToVs.startsWith('..')) {
				return full;
			}

			const mangledPath = path.join(outBuildVs, relativeToVs);
			const unmangledPath = path.join(outVs, relativeToVs);
			if (!pathExists(mangledPath) || !pathExists(unmangledPath)) {
				return full;
			}

			let effectiveImportPath = importPath;
			const barrelRedirect = resolveBarrelImport(importPath, specifiers, outBuildVs, outVs);
			if (barrelRedirect) {
				const targetPath = path.join(outBuildVs, barrelRedirect);
				effectiveImportPath = path.relative(path.dirname(virtualFilePath), targetPath).replace(/\\/g, '/');
				if (!effectiveImportPath.startsWith('.')) {
					effectiveImportPath = `./${effectiveImportPath}`;
				}
			}

			const effectiveResolved = path.normalize(path.join(path.dirname(virtualFilePath), effectiveImportPath));
			const effectiveRelativeToVs = path.relative(outBuildVs, effectiveResolved).replace(/\\/g, '/');
			const effectiveMangledPath = path.join(outBuildVs, effectiveRelativeToVs);
			const effectiveUnmangledPath = path.join(outVs, effectiveRelativeToVs);

			const nameMap = buildExportRenameMap(
				fs.readFileSync(effectiveUnmangledPath, 'utf8'),
				fs.readFileSync(effectiveMangledPath, 'utf8'),
			);
			if (nameMap.size === 0) {
				return full;
			}

			const parts = specifiers.split(',').map(part => part.trim()).filter(Boolean);
			const rewritten = parts.map(part => {
				const aliasMatch = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
				const importedName = aliasMatch ? aliasMatch[1] : part;
				const localName = aliasMatch ? aliasMatch[2] : part;
				const mangledName = nameMap.get(importedName);
				if (!mangledName || mangledName === importedName) {
					return part;
				}
				return `${mangledName} as ${localName}`;
			});

			if (rewritten.join(',') === parts.join(',')) {
				return full;
			}

			changed = true;
			return `import { ${rewritten.join(', ')} } from ${quote}${effectiveImportPath}${quote};`;
		});

		if (changed) {
			fs.writeFileSync(filePath, contents, 'utf8');
		}
	};

	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.name.endsWith('.js')) {
				rewriteFile(fullPath);
			}
		}
	};

	walk(outDir);
	console.log('[buildreact] Adapted React bundle imports for mangled production build');
}

function syncReactOutToOutBuild(outDir = path.join(__dirname, 'out')) {
	let outBuildReactOut;
	let currentPath = __dirname;
	while (true) {
		const candidate = path.join(currentPath, 'out-build', 'vs', 'workbench', 'contrib', 'orbit', 'browser', 'react', 'out');
		if (pathExists(candidate)) {
			outBuildReactOut = candidate;
			break;
		}
		const parentDir = path.dirname(currentPath);
		if (parentDir === currentPath) {
			break;
		}
		currentPath = parentDir;
	}

	if (!outBuildReactOut) {
		console.log('[buildreact] Skipping out-build React sync (out-build not found yet — run after compile, or sync manually)');
		return;
	}

	const copyDir = (src, dest) => {
		fs.mkdirSync(dest, { recursive: true });
		for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
			const srcPath = path.join(src, entry.name);
			const destPath = path.join(dest, entry.name);
			if (entry.isDirectory()) {
				copyDir(srcPath, destPath);
			} else {
				fs.copyFileSync(srcPath, destPath);
			}
		}
	};

	copyDir(outDir, outBuildReactOut);
	console.log(`[buildreact] Synced React bundles to ${outBuildReactOut}`);
}

function syncReactOutToOutVs(outDir = path.join(__dirname, 'out')) {
	let outVsReactOut;
	let currentPath = __dirname;
	while (true) {
		const candidate = path.join(currentPath, 'out', 'vs', 'workbench', 'contrib', 'orbit', 'browser', 'react', 'out');
		if (pathExists(candidate)) {
			outVsReactOut = candidate;
			break;
		}
		const parentDir = path.dirname(currentPath);
		if (parentDir === currentPath) {
			break;
		}
		currentPath = parentDir;
	}

	if (!outVsReactOut) {
		console.log('[buildreact] Skipping out/vs React sync (out/vs not found yet — run compile-client or watch first)');
		return;
	}

	const copyDir = (src, dest) => {
		fs.mkdirSync(dest, { recursive: true });
		for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
			const srcPath = path.join(src, entry.name);
			const destPath = path.join(dest, entry.name);
			if (entry.isDirectory()) {
				copyDir(srcPath, destPath);
			} else {
				fs.copyFileSync(srcPath, destPath);
			}
		}
	};

	copyDir(outDir, outVsReactOut);
	console.log(`[buildreact] Synced React bundles to ${outVsReactOut}`);
}

function doesPathExist(filePath) {
	try {
		const stats = fs.statSync(filePath);

		return stats.isFile();
	} catch (err) {
		if (err.code === 'ENOENT') {
			return false;
		}
		throw err;
	}
}

// scope-tailwind (`-o src2/`) copies src -> src2 but never removes files that were
// deleted from src, so stale/renamed sources accumulate in src2/ and can be picked up
// by the bundler. Wipe src2/ before each full (re)generation so it exactly mirrors src/.
function cleanGeneratedSrc2() {
	const src2Dir = path.join(__dirname, 'src2');
	try {
		fs.rmSync(src2Dir, { recursive: true, force: true });
		console.log('🧹 Cleaned stale src2/ before generation.');
	} catch (err) {
		console.error('⚠️  Failed to clean src2/:', err);
	}
}

/*

This function finds `globalDesiredPath` given `localDesiredPath` and `currentPath`

Diagram:

...basePath/
└── void/
	├── ...currentPath/ (defined globally)
	└── ...localDesiredPath/ (defined locally)

*/
function findDesiredPathFromLocalPath(localDesiredPath, currentPath) {

	// walk upwards until currentPath + localDesiredPath exists
	while (!doesPathExist(path.join(currentPath, localDesiredPath))) {
		const parentDir = path.dirname(currentPath);

		if (parentDir === currentPath) {
			return undefined;
		}

		currentPath = parentDir;
	}

	// return the `globallyDesiredPath`
	const globalDesiredPath = path.join(currentPath, localDesiredPath)
	return globalDesiredPath;
}

// hack to refresh styles automatically
function saveStylesFile() {
	setTimeout(() => {
		try {
			const candidatePaths = [
				path.join(__dirname, 'src2', 'styles.css'),
				path.join(process.cwd(), 'src2', 'styles.css'),
			]

			const pathToCssFile = candidatePaths.find(p => doesPathExist(p))

			if (pathToCssFile === undefined) {
				console.error('[scope-tailwind] Error finding generated src2/styles.css');
				return;
			}

			// Or re-write with the same content:
			const content = fs.readFileSync(pathToCssFile, 'utf8');
			fs.writeFileSync(pathToCssFile, content, 'utf8');
			console.log('[scope-tailwind] Force-saved styles.css');
		} catch (err) {
			console.error('[scope-tailwind] Error saving styles.css:', err);
		}
	}, 6000);
}

const args = process.argv.slice(2);
const isWatch = args.includes('--watch') || args.includes('-w');
const shouldMangleReactImports = args.includes('--mangle') || process.env.ORBIT_REACT_MANGLE === '1';

if (isWatch) {
	// this just builds it if it doesn't exist instead of waiting for the watcher to trigger
	// Start each watch session from a clean src2/ so deleted sources don't linger.
	cleanGeneratedSrc2();
	// Check if src2/ exists; if not, do an initial scope-tailwind build
	if (!fs.existsSync('src2')) {
		try {
			console.log('🔨 Running initial scope-tailwind build to create src2 folder...');
			execSync(
				'npx scope-tailwind ./src -o src2/ -s void-scope -c styles.css -p "void-"',
				{ stdio: 'inherit' }
			);
			console.log('✅ src2/ created successfully.');
		} catch (err) {
			console.error('❌ Error running initial scope-tailwind build:', err);
			process.exit(1);
		}
	}

	// Watch mode
	const scopeTailwindWatcher = spawn('npx', [
		'nodemon',
		'--watch', 'src',
		'--ext', 'ts,tsx,css',
		'--exec',
		'npx scope-tailwind ./src -o src2/ -s void-scope -c styles.css -p "void-"'
	]);

	const tsupWatcher = spawn('npx', [
		'tsup',
		'--watch'
	]);

	scopeTailwindWatcher.stdout.on('data', (data) => {
		console.log(`[scope-tailwind] ${data}`);
		// If the output mentions "styles.css", trigger the save:
		if (data.toString().includes('styles.css')) {
			saveStylesFile();
		}
	});

	scopeTailwindWatcher.stderr.on('data', (data) => {
		console.error(`[scope-tailwind] ${data}`);
	});

	// Handle tsup watcher output
	tsupWatcher.stdout.on('data', (data) => {
		console.log(`[tsup] ${data}`);
	});

	tsupWatcher.stderr.on('data', (data) => {
		console.error(`[tsup] ${data}`);
	});

	// Handle process termination
	process.on('SIGINT', () => {
		scopeTailwindWatcher.kill();
		tsupWatcher.kill();
		process.exit();
	});

	console.log('🔄 Watchers started! Press Ctrl+C to stop both watchers.');
} else {
	// Build mode
	console.log('📦 Building...');

	// Ensure src2/ is a faithful, stale-free mirror of src/ before generating.
	cleanGeneratedSrc2();

	// Run scope-tailwind once
	execSync('npx scope-tailwind ./src -o src2/ -s void-scope -c styles.css -p "void-"', { stdio: 'inherit' });

	// Build diff first — other bundles import from out/diff/index.js at bundle time.
	execSync('npx tsup src2/diff/index.tsx --out-dir ./out --format esm --platform browser --target esnext --treeshake', { stdio: 'inherit' });

	// Run tsup once for remaining entry points
	execSync('npx tsup', { stdio: 'inherit' });

	normalizeImportPathsInOutDir();
	if (shouldMangleReactImports) {
		adaptReactOutForMangledBuild();
		syncReactOutToOutBuild();
	} else {
		console.log('[buildreact] Dev build: keeping unmangled imports (pass --mangle for production/package builds)');
		syncReactOutToOutVs();
	}

	console.log('✅ Build complete!');
}
