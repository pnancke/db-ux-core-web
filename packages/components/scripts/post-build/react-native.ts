import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const transform = _require('css-to-react-native').default as (
	tuples: [string, string][]
) => Record<string, string | number>;

/** Absolute path to the monorepo root (packages/components/scripts/post-build → ../../../../) */
const REPO_ROOT = resolve(process.cwd(), '../..');

const TMP_SRC = join(REPO_ROOT, 'output/tmp/react-native/react/src');
const RN_DEST = join(REPO_ROOT, 'output/react-native/src');

// Paths used by the CSS → StyleSheet pipeline
const FOUNDATIONS_PKG = join(REPO_ROOT, 'packages/foundations');
const COMPONENTS_PKG = resolve(process.cwd()); // packages/components (cwd when tsx runs)
const COMPONENTS_CSS_BUILD = join(COMPONENTS_PKG, 'build/components');
const DB_THEME_DEFAULT_VARS = join(
	REPO_ROOT,
	'node_modules/@db-ux/db-theme/build/styles/_default_variables.scss'
);
const DB_THEME_ABSOLUTE_CSS = join(
	REPO_ROOT,
	'node_modules/@db-ux/db-theme/build/styles/absolute.css'
);

// ---------------------------------------------------------------------------
// CSS build helpers — compile foundations SCSS then component SCSS
// ---------------------------------------------------------------------------

function buildFoundationsCSS(): void {
	console.log('  [css-build] compiling foundations SCSS...');
	const root = join(FOUNDATIONS_PKG, '../..');
	const opts = { cwd: root, stdio: 'inherit' as const };
	// Run the proper build steps via npm workspace scripts (handles normalize copy etc.)
	execSync('npm -w @db-ux/core-foundations run copy-prepare:normalize', opts);
	execSync('npm -w @db-ux/core-foundations run build:02_copy', opts);
	execSync('npm -w @db-ux/core-foundations run build:03_css', opts);
	console.log('  [css-build] foundations OK');
}

function buildComponentsCSS(): void {
	console.log('  [css-build] compiling component SCSS...');
	const root = join(COMPONENTS_PKG, '../..');
	execSync(
		'npm -w @db-ux/core-components run build-style:01_sass',
		{ cwd: root, stdio: 'inherit' as const }
	);
	console.log('  [css-build] components OK');
}

// ---------------------------------------------------------------------------
// CSS variable map — parses all foundations + db-theme CSS to resolve tokens
// ---------------------------------------------------------------------------

type CSSVarMap = Record<string, string>;

/** Parse CSS custom property declarations from any CSS/SCSS source text */
function parseCSSVars(src: string, map: CSSVarMap): void {
	for (const match of src.matchAll(/^\s*(--[\w-]+)\s*:\s*([^;]+);/gm)) {
		const name = match[1].trim();
		if (!(name in map)) map[name] = match[2].trim();
	}
}

function buildCSSVarMap(): CSSVarMap {
	const map: CSSVarMap = {};

	// 1. Base palette from db-theme (hex colors, spacing values, etc.)
	if (existsSync(DB_THEME_DEFAULT_VARS)) {
		parseCSSVars(readFileSync(DB_THEME_DEFAULT_VARS, 'utf-8'), map);
	}

	// 2. @property initial-value blocks from absolute.css (covers numbers/lengths)
	if (existsSync(DB_THEME_ABSOLUTE_CSS)) {
		const src = readFileSync(DB_THEME_ABSOLUTE_CSS, 'utf-8');
		for (const block of src.matchAll(/@property\s+(--[\w-]+)\s*\{([^}]+)\}/gs)) {
			const varName = block[1];
			const iv = block[2].match(/initial-value\s*:\s*([^;]+);/);
			if (iv && !(varName in map)) map[varName] = iv[1].trim();
		}
	}

	// 3. Foundations built CSS (adaptive/semantic color aliases)
	//    These reference the base palette via light-dark() — we extract light values.
	const foundationsDefaultsDir = join(FOUNDATIONS_PKG, 'build/styles/defaults');
	const foundationsCSSFiles = [
		join(FOUNDATIONS_PKG, 'build/styles/bundle.css'),
		join(foundationsDefaultsDir, 'default-required.css'),
		join(foundationsDefaultsDir, 'default-root.css'),
		join(foundationsDefaultsDir, 'default-elevation.css'),
	];
	for (const f of foundationsCSSFiles) {
		if (existsSync(f)) parseCSSVars(readFileSync(f, 'utf-8'), map);
	}

	return map;
}

/**
 * Resolve all `var(--db-*)` references in a CSS value.
 * Also resolves `light-dark(light, dark)` by picking the light (first) value.
 */
function resolveCSSValue(value: string, varMap: CSSVarMap, depth = 0): string {
	if (depth > 10) return value;

	// Normalize whitespace (multi-line values from SCSS output)
	let result = value.replace(/[\n\r\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

	// Strip !important
	result = result.replace(/\s*!important\s*$/, '').trim();

	// Skip color-mix() — these are dynamic browser-only values, no RN equivalent
	if (result.includes('color-mix(')) return '';

	// Resolve light-dark(light, dark) → take first (light) arg using paren-balanced scan
	result = result.replace(/light-dark\(/g, '\x00LIGHTDARK\x00(');
	result = result.replace(/\x00LIGHTDARK\x00\(([^]*)/s, (_m, rest) => {
		// Walk 'rest' to find the top-level comma, respecting nested ()
		let d = 1, i = 0;
		let firstCommaAt = -1;
		let closeAt = -1;
		while (i < rest.length && d > 0) {
			if (rest[i] === '(') d++;
			else if (rest[i] === ')') { d--; if (d === 0) { closeAt = i; break; } }
			else if (rest[i] === ',' && d === 1 && firstCommaAt < 0) firstCommaAt = i;
			i++;
		}
		const lightVal = firstCommaAt >= 0
			? rest.slice(0, firstCommaAt).trim()
			: (closeAt >= 0 ? rest.slice(0, closeAt).trim() : rest.trim());
		const after = closeAt >= 0 ? rest.slice(closeAt + 1) : '';
		return lightVal + after;
	});

	// Resolve var(--name, fallback) — use paren-balanced extraction for fallback
	result = result.replace(/var\(\s*(--[\w-]+)\s*(?:,([^)]*(?:\([^)]*\)[^)]*)*))?\)/g, (_m, name, fallback) => {
		const resolved = varMap[name];
		if (resolved) return resolveCSSValue(resolved, varMap, depth + 1);
		if (fallback) return resolveCSSValue(fallback.trim(), varMap, depth + 1);
		return _m;
	});

	return result;
}

// ---------------------------------------------------------------------------
// CSS property → React Native style conversion (via css-to-react-native)
// ---------------------------------------------------------------------------

type RNStyleObject = Record<string, string | number>;

// Properties that are web-only and should be silently dropped before passing
// to css-to-react-native (the library throws on unknowns).
const CSS_SKIP_PROPS = new Set([
	'display', 'cursor', 'transition', 'animation', 'animation-name',
	'animation-duration', 'animation-timing-function', 'animation-fill-mode',
	'transform', 'transform-origin', 'filter', 'box-shadow', 'box-sizing',
	'outline', 'resize', 'appearance', 'pointer-events', 'user-select',
	'white-space', 'word-break', 'overflow-wrap', 'word-wrap',
	'vertical-align', 'content', 'list-style', 'list-style-type',
	'visibility', 'clip', 'clip-path', 'will-change', 'contain',
	'isolation', 'mix-blend-mode', 'backdrop-filter', 'scroll-behavior',
	'scrollbar-width', 'scrollbar-color', 'text-overflow', 'text-shadow',
	'text-decoration-line', 'text-decoration-color', 'text-decoration-thickness',
	'text-underline-offset', 'columns', 'column-count',
	'float', 'clear', 'grid', 'grid-template', 'grid-area',
	'grid-column', 'grid-row', 'grid-template-areas', 'grid-template-columns',
	'grid-template-rows', 'place-items', 'place-content',
	'inset', 'inset-block', 'inset-inline',
	'inset-block-start', 'inset-block-end',
	'inset-inline-start', 'inset-inline-end',
	'border-block', 'border-inline', 'font',
	// text-align is only valid on Text nodes in RN, skip to avoid View warnings
	'text-align', 'text-align-last',
	// text-decoration sub-properties not supported in RN (only textDecorationLine is)
	'text-decoration-color', 'text-decoration-style', 'text-decoration-thickness',
	'text-decoration-line', 'text-decoration-skip-ink',
]);

// CSS logical properties → their RN equivalents (pre-mapped before transform)
const LOGICAL_PROP_MAP: Record<string, string> = {
	'padding-inline': 'padding-horizontal',
	'padding-block': 'padding-vertical',
	'padding-inline-start': 'padding-start',
	'padding-inline-end': 'padding-end',
	'padding-block-start': 'padding-top',
	'padding-block-end': 'padding-bottom',
	'margin-inline': 'margin-horizontal',
	'margin-block': 'margin-vertical',
	'margin-inline-start': 'margin-start',
	'margin-inline-end': 'margin-end',
	'margin-block-start': 'margin-top',
	'margin-block-end': 'margin-bottom',
	'inline-size': 'width',
	'block-size': 'height',
	'min-inline-size': 'min-width',
	'max-inline-size': 'max-width',
	'min-block-size': 'min-height',
	'max-block-size': 'max-height',
};

// RN position only supports 'absolute' | 'relative' — 'fixed'/'sticky' must be dropped
const SKIP_PROP_VALUES: Record<string, Set<string>> = {
	'position': new Set(['fixed', 'sticky']),
};

// Values that are CSS-only and should be skipped
const SKIP_VALUES = new Set(['fit-content', 'max-content', 'min-content', 'auto', 'normal', 'inherit', 'unset', 'revert', 'initial']);

/** Convert rem/em/px strings to numbers in a transform result. */
function normalizeStyleValues(styles: Record<string, unknown>): RNStyleObject {
	const result: RNStyleObject = {};
	for (const [key, val] of Object.entries(styles)) {
		if (typeof val === 'number') {
			result[key] = val;
		} else if (typeof val === 'string') {
			const remMatch = val.match(/^(-?[\d.]+)rem$/);
			if (remMatch) { result[key] = Math.round(parseFloat(remMatch[1]) * 16); continue; }
			const pxMatch = val.match(/^(-?[\d.]+)px$/);
			if (pxMatch) { result[key] = parseFloat(pxMatch[1]); continue; }
			const emMatch = val.match(/^(-?[\d.]+)em$/);
			if (emMatch) { result[key] = Math.round(parseFloat(emMatch[1]) * 14); continue; }
			// Drop multi-value strings (e.g. "0.5rem 1rem") or unresolved units
			if (/[\d]+(rem|em|px)\s+[\d]/.test(val)) continue;
			if (/ /.test(val) && /\d+(rem|em|px)/.test(val)) continue;
			// Drop multi-word keyword values (e.g. "hidden auto") — RN needs single keywords
			if (/ /.test(val) && /^[a-z-]+ [a-z-]/.test(val)) continue;
			result[key] = val;
		}
	}
	return result;
}

/**
 * Converts a single CSS declaration (property + resolved value) to a RN style
 * object using css-to-react-native. Returns {} on failure or unsupported prop.
 */
function cssDeclarationToRN(prop: string, value: string): RNStyleObject {
	prop = prop.trim().toLowerCase();
	value = value.trim();

	// Drop CSS custom properties, web-only, and any grid-* properties
	if (prop.startsWith('--') || prop.startsWith('grid-') || CSS_SKIP_PROPS.has(prop)) return {};

	// Drop unresolvable or web-only values
	if (value.includes('var(') || value.includes('calc(')) return {};
	if (!value || SKIP_VALUES.has(value)) return {};
	// Drop prop+value combos that are invalid in RN (e.g. position: fixed)
	if (SKIP_PROP_VALUES[prop]?.has(value)) return {};

	// Map CSS logical properties to the RN-compatible names transform understands
	const mappedProp = LOGICAL_PROP_MAP[prop] ?? prop;

	try {
		const raw = transform([[mappedProp, value]]);
		return normalizeStyleValues(raw);
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// CSS rule extractor — parses compiled CSS and produces per-class RN styles
// ---------------------------------------------------------------------------

interface ParsedRule {
	/** e.g. "db-badge" */
	className: string;
	/** data attribute name if selector is .db-xxx[data-yyy=zzz] */
	dataAttr?: string;
	/** data attribute value */
	dataValue?: string;
	styles: RNStyleObject;
}

/**
 * Walk a CSS string extracting top-level rule blocks using brace balancing.
 * At-rules (@layer, @media, @keyframes, etc.) are skipped entirely.
 */
function extractTopLevelRules(css: string): Array<{ selector: string; declarations: string }> {
	const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
	const result: Array<{ selector: string; declarations: string }> = [];
	let i = 0;
	const len = stripped.length;

	while (i < len) {
		while (i < len && /\s/.test(stripped[i])) i++;
		if (i >= len) break;

		const start = i;
		while (i < len && stripped[i] !== '{' && stripped[i] !== ';') i++;
		if (i >= len) break;

		if (stripped[i] === ';') { i++; continue; }

		const selector = stripped.slice(start, i).trim();
		i++; // skip '{'

		let depth = 1;
		const bodyStart = i;
		while (i < len && depth > 0) {
			if (stripped[i] === '{') depth++;
			else if (stripped[i] === '}') depth--;
			i++;
		}
		const body = stripped.slice(bodyStart, i - 1);

		if (selector.startsWith('@')) continue;

		result.push({ selector, declarations: body });
	}

	return result;
}

/**
 * Parses a CSS file and returns all rules matching simple \`.db-{name}\` selectors
 * (optionally with a single \`[data-attr=value]\` modifier).
 * Pseudo-classes, pseudo-elements, and multi-class selectors are skipped.
 */
function parseCSSRules(cssContent: string, varMap: CSSVarMap): ParsedRule[] {
	const rules: ParsedRule[] = [];

	for (const { selector, declarations } of extractTopLevelRules(cssContent)) {
		for (const rawSel of selector.split(',')) {
			const sel = rawSel.trim();

			const simpleMatch = sel.match(
				/^\.(db-[\w-]+)(?:\[data-([\w-]+)=["'"]?([\w-]+)["'"]?\])?$/
			);
			if (!simpleMatch) continue;
			if (/[: >+~]/.test(sel)) continue;

			const className = simpleMatch[1];
			const dataAttr = simpleMatch[2];
			const dataValue = simpleMatch[3];

			const styles: RNStyleObject = {};
			for (const decl of declarations.split(';')) {
				const colon = decl.indexOf(':');
				if (colon < 0) continue;
				const prop = decl.slice(0, colon).trim();
				const val = decl.slice(colon + 1).trim();
				if (!prop || !val) continue;
				const resolved = resolveCSSValue(val, varMap);
				Object.assign(styles, cssDeclarationToRN(prop, resolved));
			}

			if (Object.keys(styles).length > 0) {
				rules.push({ className, dataAttr, dataValue, styles });
			}
		}
	}

	return rules;
}


/**
 * For a given component name, reads its compiled CSS and returns a map of
 * StyleSheet keys → RN style objects.
 *
 * Keys:
 *   - "db-xxx"               → base styles for .db-xxx
 *   - "db-xxx__attr__value"  → additional styles for .db-xxx[data-attr=value]
 */
function buildComponentStyles(
	componentName: string,
	varMap: CSSVarMap
): Record<string, RNStyleObject> {
	const cssFile = join(COMPONENTS_CSS_BUILD, componentName, `${componentName}.css`);
	if (!existsSync(cssFile)) return {};

	const css = readFileSync(cssFile, 'utf-8');
	const rules = parseCSSRules(css, varMap);
	const result: Record<string, RNStyleObject> = {};

	for (const rule of rules) {
		const key = rule.dataAttr
			? `${rule.className}__${rule.dataAttr}__${rule.dataValue}`
			: rule.className;

		if (!result[key]) {
			result[key] = { ...rule.styles };
		} else {
			Object.assign(result[key], rule.styles);
		}
	}

	return result;
}

/**
 * Renders a StyleSheet.create({...}) source string from a style map.
 * Used for injection into generated component files.
 */
function renderStyleSheet(styleMap: Record<string, RNStyleObject>): string {
	const entries = Object.entries(styleMap);
	if (entries.length === 0) return 'const styles = StyleSheet.create({});\n';

	const lines: string[] = ['const styles = StyleSheet.create({'];
	for (const [key, styles] of entries) {
		const safeKey = /^[a-zA-Z_$][\w$]*$/.test(key) ? key : `"${key}"`;
		lines.push(`  ${safeKey}: {`);
		for (const [prop, val] of Object.entries(styles)) {
			const serialized = typeof val === 'string' ? `"${val}"` : String(val);
			lines.push(`    ${prop}: ${serialized},`);
		}
		lines.push('  },');
	}
	lines.push('});\n');
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Global text transformations applied to every generated TSX file
// ---------------------------------------------------------------------------

const REMOVE_PATTERNS: RegExp[] = [
	/^"use client";\n?/m,
	/^ import \{ filterPassingProps, getRootProps \} from "\.\.\/\.\.\/utils\/react";\n?/m,
	/import \{[^}]*(?:addValueResetEventListener|addCheckedResetEventListener|addResetEventListener)[^}]*\} from "\.\.\/\.\.\/utils\/form-components";\n?/g,
	/import \{[^}]*(?:handleFrameworkEventAngular|handleFrameworkEventVue)[^}]*\} from "\.\.\/\.\.\/utils\/form-components";\n?/g,
	/import \{ ?DocumentScrollListener ?\} from "\.\.\/\.\.\/utils\/document-scroll-listener";\n?/g,
	/import \{ ?handleFixedPopover ?\} from "\.\.\/\.\.\/utils\/floating-components";\n?/g,
	/import \{ ?isEventTargetNavigationItem ?\} from "\.\.\/\.\.\/utils\/navigation";\n?/g,
	/import \{[^}]*addAttributeToChildren[^}]*\} from "\.\.\/\.\.\/utils";\n?/g,
	// Remove filterPassingProps / getRootProps spread lines from JSX
	/[ \t]*\{\.\.\.filterPassingProps\(props,\[[^\]]*\]\)\}\n?/g,
	/[ \t]*\{\.\.\.getRootProps\(props,\[[^\]]*\]\)\}\n?/g,
	// Remove id prop with propOverrides pattern
	/[ \t]*id=\{props\.id \?\? props\.propOverrides\?\.id\}\n?/g,
	// Remove data-* attribute lines from JSX
	/[ \t]*data-[a-zA-Z-]+=\{[^}]+\}\n?/g,
	/[ \t]*data-[a-zA-Z-]+="[^"]*"\n?/g,
	// Remove aria-* lines
	/[ \t]*aria-[a-zA-Z-]+=\{[^}]+\}\n?/g,
	/[ \t]*aria-[a-zA-Z-]+="[^"]*"\n?/g,
	/[ \t]*tabIndex=\{[^}]+\}\n?/g,
	// Remove web-only util calls
	/[ \t]*handleFrameworkEventAngular\([^)]*\);\n?/g,
	/[ \t]*handleFrameworkEventVue\([^)]*\);\n?/g,
	/[ \t]*addValueResetEventListener\([\s\S]*?\);\n?/g,
	/[ \t]*addCheckedResetEventListener\([\s\S]*?\);\n?/g,
	/[ \t]*addResetEventListener\([\s\S]*?\);\n?/g,
	// Remove document/window calls
	/[ \t]*document\.[^;]+;\n?/g,
	/[ \t]*window\.[^;]+;\n?/g,
	// Remove hasVoiceOver blocks
	/[ \t]*if \(hasVoiceOver\(\)\) \{[^}]+\}\n?/g,
	// Remove isIOSSafari blocks
	/[ \t]*if \(isIOSSafari\(\)\) \{[^}]+\}\n?/g,
	// Remove addAttributeToChildren calls
	/[ \t]*addAttributeToChildren\([^;]+\);\n?/g,
	// Remove querySelector / DOM method calls
	/[ \t]*const [a-zA-Z_]+ = _ref\.current\??\.(querySelector|querySelectorAll|getElementsByClassName)[^;]+;\n?/g,
	// Remove MutationObserver / ResizeObserver
	/[ \t]*(?:const )?observer = new (?:MutationObserver|ResizeObserver)\([^;]+;\n?/g,
	/[ \t]*observer\.(observe|disconnect)\([^;]*\);\n?/g
];

const REPLACEMENTS: Array<[RegExp | string, string]> = [
	// Patch DOM-only observer types in model files (not in lib: ["es2022"])
	[/_resizeObserver\?: ResizeObserver;/g, '_resizeObserver?: unknown;'],
	[/_observer\?: IntersectionObserver;/g, '_observer?: unknown;'],
	// Fix React import — hooks are imported from react, RN components imported separately
	[
		`import * as React from "react";`,
		`import React, { useRef, useState, useEffect, forwardRef, useId } from "react";
import { View, TouchableOpacity, TextInput, ScrollView, Modal, Pressable, SafeAreaView, StyleSheet, Image } from "react-native";
import DBText from "../text/text";
import * as Linking from "expo-linking";`
	],
	// Remove the duplicated hook import lines mitosis generates
	[/^import \{ [^}]+ \} from "react";\n?/gm, ''],
	[/^import \{ useId \} from "react";\n?/gm, ''],

	// --- forwardRef / function signature type cleanup ---
	[/Omit<\w*HTMLAttributes<HTML\w+Element \| any>, keyof \w+> & /g, ''],
	[/Omit<AnchorHTMLAttributes<HTMLAnchorElement \| any>, keyof \w+> & /g, ''],
	// forwardRef type arg: HTML*Element → View
	[/forwardRef<\nHTML\w+Element \| any,\n[^>]+>/g,
		(m: string) => m.replace(/HTML\w+Element \| any/, 'View')],
	[/forwardRef<HTML\w+Element \| any,/g, 'forwardRef<View,'],

	// --- HTML element → RN/Expo ---
	// Block containers
	[/<(div|section|nav|menu|ul|ol|li|main|footer|article|aside|figure|figcaption)\b([^>]*)>/g, '<View$2>'],
	[/<\/(div|section|nav|menu|ul|ol|li|main|footer|article|aside|figure|figcaption)>/g, '</View>'],
	// header HTML element (not DBHeader component)
	[/<header\b([^>]*)>/g, '<View$1>'],
	[/<\/header>/g, '</View>'],
	// span → View
	[/<span\b([^>]*)>/g, '<View$1>'],
	[/<\/span>/g, '</View>'],
	// button → Pressable
	[/<button\b([^>]*)>/g, '<Pressable$1>'],
	[/<\/button>/g, '</Pressable>'],
	// input (self-closing) → TextInput
	[/<input\b([^/>]*)\/?>/g, '<TextInput$1/>'],
	// textarea → TextInput multiline
	[/<textarea\b([^>]*)>/g, '<TextInput multiline$1>'],
	[/<\/textarea>/g, '</TextInput>'],
	// label → Text
	[/<label\b([^>]*)>/g, '<Text$1>'],
	[/<\/label>/g, '</DBText>'],
	// anchor → Pressable
	[/<a\b([^>]*)>/g, '<Pressable$1>'],
	[/<\/a>/g, '</Pressable>'],
	// dialog → Modal
	[/<dialog\b([^>]*)>/g, '<Modal$1>'],
	[/<\/dialog>/g, '</Modal>'],
	// img → Image
	[/<img\b([^/>]*)\/?>/g, '<Image$1/>'],
	// select/option → View
	[/<select\b([^>]*)>/g, '<View$1>'],
	[/<\/select>/g, '</View>'],
	[/<option\b([^>]*)>/g, '<View$1>'],
	[/<\/option>/g, '</View>'],

	// --- Events ---
	[/\bonClick=/g, 'onPress='],
	[/\bonChange=/g, 'onChange='],
	[/\bonInput=/g, 'onChangeText='],

	// --- className → removed (no-op via utils.cls) ---
	[/[ \t]*className=\{[^}]+\}\n?/g, '\n'],

	// --- Strip HTML-only props ---
	[/[ \t]*type=\{getButtonType\(\)\}\n?/g, '\n'],
	[/[ \t]*type="[^"]*"\n?/g, '\n'],
	[/[ \t]*form=\{[^}]+\}\n?/g, '\n'],
	[/[ \t]*name=\{[^}]+\}\n?/g, '\n'],
	[/[ \t]*referrerPolicy=\{[^}]+\}\n?/g, '\n'],
	[/[ \t]*hrefLang=\{[^}]+\}\n?/g, '\n'],
	[/[ \t]*target=\{[^}]+\}\n?/g, '\n'],
	[/[ \t]*rel=\{[^}]+\}\n?/g, '\n'],
	[/[ \t]*role=\{[^}]+\}\n?/g, '\n'],
	[/[ \t]*href=\{[^}]+\}\n?/g, '\n'],
	// disabled / checked / required → Boolean()
	[/disabled=\{getBoolean\(props\.disabled, "disabled"\)\}/g, 'disabled={Boolean(props.disabled)}'],
	[/required=\{getBoolean\(props\.required, "required"\)\}/g, ''],
	[/checked=\{getBoolean\(props\.checked, "checked"\)\}/g, 'value={Boolean(props.checked)}'],
	// Generic getBoolean
	[/getBoolean\(([^,)]+),\s*"[^"]+"\)/g, 'Boolean($1)'],
	// getBooleanAsString → String
	[/getBooleanAsString\(([^)]+)\)/g, 'String($1)'],
	// Fix useRef types
	[/component \|\| useRef<HTML\w+Element \| any>\(component\)/g, 'component || useRef<View>(null)'],
	[/useRef<HTML\w+Element \| any>\(([^)]*)\)/g, 'useRef<View>($1)'],
	// Clean up blank lines
	[/\n{3,}/g, '\n\n']
];

// ---------------------------------------------------------------------------
// RN-compatible utility files
// ---------------------------------------------------------------------------

const RN_UTILS = `import React from "react";

export const uuid = (): string =>
  Math.random().toString(36).substring(2) + Date.now().toString(36);

export type ClassNameArg = string | Record<string, boolean | undefined> | undefined;

/** No-op in React Native — CSS class names have no meaning here */
export const cls = (..._args: ClassNameArg[]): string => "";

export const isArrayOfStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export const hasVoiceOver = (): boolean => false;
export const isIOSSafari = (): boolean => false;

export const delay = (fn: () => void, ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(() => { fn(); resolve(); }, ms));

export const getBoolean = (
  value: boolean | string | undefined,
  _attr?: string
): boolean | undefined => {
  if (value == null) return undefined;
  if (typeof value === "boolean") return value;
  return value !== "false" && value !== "";
};

export const getBooleanAsString = (value: boolean | string | undefined): string | undefined => {
  if (value == null) return undefined;
  return String(value);
};

export const getHideProp = (show?: boolean | string): string | undefined => {
  if (show == null) return undefined;
  return getBoolean(show) ? "false" : "true";
};

export const getNumber = (value: string | number | undefined): number | undefined => {
  if (value == null) return undefined;
  const n = Number(value);
  return isNaN(n) ? undefined : n;
};

export const getStep = (value: string | number | undefined): number | string | undefined =>
  value ?? undefined;

export const getInputValue = (value: unknown): string => String(value ?? "");

export const getOptionKey = (
  option: unknown,
  index: number,
  prefix = ""
): string => {
  if (typeof option === "string") return \`\${prefix}\${option}\`;
  if (typeof option === "object" && option !== null) {
    const o = option as Record<string, unknown>;
    return \`\${prefix}\${o["value"] ?? o["label"] ?? index}\`;
  }
  return \`\${prefix}\${index}\`;
};

export const stringPropVisible = (
  value: string | undefined,
  show: boolean | string | undefined
): boolean => {
  if (!value) return false;
  if (show === undefined) return true;
  return getBoolean(show) !== false;
};

/** Notification role — always "alert" in RN (no live regions) */
export const getNotificationRole = (_semantic?: string): string => "alert";

export const isKeyboardEvent = <T>(_event: unknown): _event is React.KeyboardEvent<T> =>
  false;

export const addAttributeToChildren = (..._args: unknown[]): void => {};
`;

const RN_FORM_COMPONENTS_UTILS = `/** Stubs for web-only form framework helpers — no-ops in React Native */
export const addValueResetEventListener = (..._args: unknown[]): void => {};
export const addCheckedResetEventListener = (..._args: unknown[]): void => {};
export const addResetEventListener = (..._args: unknown[]): void => {};
export const handleFrameworkEventAngular = (..._args: unknown[]): void => {};
export const handleFrameworkEventVue = (..._args: unknown[]): void => {};
`;

const RN_SHARED_MODEL_PATCH = `
/* React Native event type aliases */
import type { GestureResponderEvent, NativeSyntheticEvent, TextInputChangeEventData } from "react-native";
export type ClickEvent<_T> = GestureResponderEvent;
export type ChangeEvent<_T> = NativeSyntheticEvent<TextInputChangeEventData>;
export type InputEvent<_T> = string;
export type InteractionEvent<_T> = GestureResponderEvent;
export type GeneralEvent<_T> = GestureResponderEvent;
export type GeneralKeyboardEvent<_T> = GestureResponderEvent;
`;

// ---------------------------------------------------------------------------
// DB design tokens for React Native
// ---------------------------------------------------------------------------

/**
 * Resolve badge-relevant CSS custom properties for a given semantic.
 * Both weak and strong emphasis use emphasis-70 for border (per badge.css).
 */
function resolveBadgePalette(
	semantic: string,
	cssVarMap: CSSVarMap
): { weakBg: string; weakText: string; border: string; strongBg: string; strongText: string } {
	const r = (varName: string) => resolveCSSValue(`var(${varName})`, cssVarMap).trim();
	const sem = semantic === 'adaptive' ? 'adaptive' : semantic;
	return {
		weakBg:   r(`--db-${sem}-bg-basic-level-3-default`),
		weakText: r(`--db-${sem}-on-bg-basic-emphasis-80-default`),
		border:   r(`--db-${sem}-on-bg-basic-emphasis-70-default`),
		strongBg: r(`--db-${sem}-bg-vibrant-default`),
		strongText: r(`--db-${sem}-on-bg-vibrant-default`),
	};
}

function buildTokensFile(cssVarMap: CSSVarMap): string {
	const semantics = ['neutral', 'adaptive', 'brand', 'critical', 'informational', 'successful', 'warning'] as const;

	const paletteLines = semantics.map((sem) => {
		// brand has no CSS vars under that name — reuse critical (same red hue)
		const cssKey = sem === 'brand' ? 'critical' : sem;
		const p = resolveBadgePalette(cssKey, cssVarMap);
		const pad = ' '.repeat(Math.max(0, 13 - sem.length));
		return `  ${sem}:${pad}{ weakBg: '${p.weakBg}', weakText: '${p.weakText}', border: '${p.border}', strongBg: '${p.strongBg}', strongText: '${p.strongText}' },`;
	});

	return `/**
 * DB UX Design System – React Native design tokens
 * Color values resolved from @db-ux/core-foundations CSS custom properties at build time.
 * Import in your app: import { DBColors, DBTypography, DBSpacing } from "@db-ux/react-native-core-components";
 */

/**
 * Per-semantic badge/tag color palette resolved from CSS custom properties (light mode).
 *
 * CSS variable mapping:
 *   weakBg   ← --db-{sem}-bg-basic-level-3-default
 *   weakText ← --db-{sem}-on-bg-basic-emphasis-80-default
 *   border   ← --db-{sem}-on-bg-basic-emphasis-70-default  (same for weak and strong per CSS)
 *   strongBg ← --db-{sem}-bg-vibrant-default
 *   strongText ← --db-{sem}-on-bg-vibrant-default
 */
export const DBColorPalette = {
${paletteLines.join('\n')}
} as const;

/** Per-semantic badge/tag color palette — dark mode variant. */
export const DBColorPaletteDark = {
  neutral:       { weakBg: '#3b3e44', weakText: '#a6abb6', border: '#8a919e', strongBg: '#646973', strongText: '#edeef0' },
  informational: { weakBg: '#0d2535', weakText: '#60bde0', border: '#2e9acb', strongBg: '#1b6586', strongText: '#cae6fd' },
  successful:    { weakBg: '#162508', weakText: '#72bf1a', border: '#4e850f', strongBg: '#3a640e', strongText: '#c3ff9d' },
  warning:       { weakBg: '#2a1a00', weakText: '#f69400', border: '#ad6600', strongBg: '#7a4800', strongText: '#ffdbc8' },
  critical:      { weakBg: '#2a0005', weakText: '#ff5357', border: '#c00010', strongBg: '#8f0010', strongText: '#ffdada' },
  brand:         { weakBg: '#2a0005', weakText: '#ff5357', border: '#c00010', strongBg: '#8f0010', strongText: '#ffdada' },
} as const;

/**
 * Semantic color tokens for light and dark mode.
 * Use via useDBFont() context: const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
 */
export const DBTheme = {
  light: {
    bg:           '#ffffff',  // neutral[14] — page background
    bgSurface:    '#f3f3f5',  // neutral[13] — card / surface
    bgElevated:   '#edeef0',  // neutral[12] — elevated surface
    text:         '#2e3036',  // neutral[3]  — primary text
    textMuted:    '#5a5e68',  // neutral[6]  — secondary text
    textSubtle:   '#727782',  // neutral[7]  — placeholder / subtle
    textDisabled: '#c3c7ce',  // neutral[10] — disabled
    border:       '#e1e2e6',  // neutral[11] — dividers / soft borders
    borderStrong: '#727782',  // neutral[7]  — input borders
    brandPrimary: '#ec0016',  // brand red
    brandText:    '#c00010',  // brand dark red (on light bg)
    inputBg:      '#ffffff',  // neutral[14]
    switchTrack:  '#c3c7ce',  // neutral[10] — inactive switch track
    shadowColor:  '#000000',
  },
  dark: {
    bg:           '#16181b',  // neutral[1]  — page background
    bgSurface:    '#222428',  // neutral[2]  — card / surface
    bgElevated:   '#2e3036',  // neutral[3]  — elevated surface
    text:         '#edeef0',  // neutral[12] — primary text
    textMuted:    '#a6abb6',  // neutral[9]  — secondary text
    textSubtle:   '#8a919e',  // neutral[8]  — placeholder / subtle
    textDisabled: '#5a5e68',  // neutral[6]  — disabled
    border:       '#3b3e44',  // neutral[4]  — dividers
    borderStrong: '#727782',  // neutral[7]  — input borders
    brandPrimary: '#ec0016',  // brand red (unchanged)
    brandText:    '#ff5357',  // brand light red (on dark bg)
    inputBg:      '#222428',  // neutral[2]
    switchTrack:  '#484b53',  // neutral[5]  — inactive switch track
    shadowColor:  '#000000',
  },
} as const;

export type DBThemeColors = typeof DBTheme.light;

/** Neutral (grey) scale — 0 = darkest, 14 = white */
export const DBColors = {
  neutral: {
    0: '#0d0e11',
    1: '#16181b',
    2: '#222428',
    3: '#2e3036',
    4: '#3b3e44',
    5: '#484b53',
    6: '#5a5e68',
    7: '#727782',
    8: '#8a919e',
    9: '#a6abb6',
    10: '#c3c7ce',
    11: '#e1e2e6',
    12: '#edeef0',
    13: '#f3f3f5',
    14: '#ffffff',
    /** Border / neutral origin */
    origin: '#646973',
  },
  /** DB brand red */
  brand: {
    origin: '#ec0016',
    dark: '#c00010',
    light: '#ff5357',
    extraLight: '#ffdada',
  },
  /** Informational (blue) */
  informational: {
    origin: '#257fa8',
    dark: '#1b6586',
    light: '#2e9acb',
    extraLight: '#cae6fd',
  },
  /** Successful (green) */
  successful: {
    origin: '#63a615',
    dark: '#4e850f',
    light: '#72bf1a',
    extraLight: '#c3ff9d',
  },
  /** Warning (amber) */
  warning: {
    origin: '#f39200',
    dark: '#ad6600',
    light: '#f69400',
    extraLight: '#ffdbc8',
  },
  /** Critical — same hue as brand red */
  critical: {
    origin: '#ec0016',
    dark: '#c00010',
    light: '#ff5357',
    extraLight: '#ffdada',
  },
} as const;

/**
 * Font family names loaded by DBFontProvider.
 * Use these in StyleSheet to apply the DB typeface (DBNeoScreenSans).
 */
export const DBFontFamily = {
  regular:  'DBNeoScreenSans-Regular',
  medium:   'DBNeoScreenSans-Medium',
  semibold: 'DBNeoScreenSans-SemiBold',
  bold:     'DBNeoScreenSans-Bold',
} as const;

export const DBTypography = {
  size3XS: 11,
  size2XS: 12,
  sizeXS: 13,
  sizeSM: 14,
  sizeMD: 16,
  sizeLG: 20,
  sizeXL: 24,
  weightRegular: '400' as const,
  weightMedium: '500' as const,
  weightBold: '700' as const,
  lineHeightSM: 18,
  lineHeightMD: 20,
  lineHeightLG: 24,
} as const;

export const DBSpacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const DBBorderRadius = {
  sm: 4,
  md: 8,
  lg: 12,
  full: 9999,
} as const;
`;
}

// ---------------------------------------------------------------------------
// Per-component manual implementations using Expo APIs
// ---------------------------------------------------------------------------

const COMPONENT_OVERRIDES: Record<string, string> = {

	/* ---- DBText → themed Text ---- */
	'text/model.ts': `export interface DBTextProps {
  /** Semantic text style — controls colour and default size/weight. */
  variant?: "body" | "heading" | "label" | "subtle" | "caption" | "overline" | "brand" | "disabled";
  /** Override font size. */
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  /** Override font weight. */
  weight?: "regular" | "medium" | "bold";
  children?: React.ReactNode;
  style?: any;
  numberOfLines?: number;
  ellipsizeMode?: "head" | "middle" | "tail" | "clip";
  onPress?: () => void;
  selectable?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}
`,

	'accordion-item/model.ts': `import { GlobalProps, InitializedState, NameProps, NameState, TextProps, ToggleEventProps, ToggleEventState } from '../../shared/model';
export type DBAccordionItemDefaultProps = {
  defaultOpen?: boolean;
  disabled?: boolean | string;
  headline?: any;
  headlinePlain?: string;
  /** Plain-text content rendered inside the accordion body */
  content?: string;
} & TextProps;
export type DBAccordionItemProps = DBAccordionItemDefaultProps & GlobalProps & ToggleEventProps & NameProps;
export type DBAccordionItemDefaultState = { _open?: boolean };
export type DBAccordionItemState = DBAccordionItemDefaultState & ToggleEventState<HTMLElement> & InitializedState & NameState;
`,

	'tab-list/model.ts': `import { GlobalProps } from '../../shared/model';
export type DBTabListDefaultProps = {
  /** Use "full" to have tabs fill the available width */
  width?: "full" | "auto";
  /** Horizontal alignment of tab labels when width="full" */
  alignment?: "start" | "center";
};
export type DBTabListProps = DBTabListDefaultProps & GlobalProps;
export type DBTabListDefaultState = {};
export type DBTabListState = DBTabListDefaultState;
`,

	'section/model.ts': `import { ContainerWidthProps, GlobalProps, SpacingProps } from '../../shared/model';
import type { ViewStyle } from "react-native";
export type DBSectionDefaultProps = {
  /** Visual density of the section: functional (compact), regular (default), expressive (spacious) */
  density?: "functional" | "regular" | "expressive";
  /** Native style override */
  style?: ViewStyle | ViewStyle[];
};
export type DBSectionProps = DBSectionDefaultProps & GlobalProps & SpacingProps & ContainerWidthProps;
export type DBSectionDefaultState = {};
export type DBSectionState = DBSectionDefaultState;
`,

	'text/text.tsx': `import React from "react";
import { Platform, Text } from "react-native";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme, DBTypography } from "../../shared/tokens";
import type { DBTextProps } from "./model";

const VARIANT_COLOR: Record<NonNullable<DBTextProps["variant"]>, keyof typeof DBTheme.light> = {
  body:     "text",
  heading:  "text",
  label:    "textMuted",
  subtle:   "textSubtle",
  caption:  "textSubtle",
  overline: "textSubtle",
  brand:    "brandText",
  disabled: "textDisabled",
};

const VARIANT_SIZE: Record<NonNullable<DBTextProps["variant"]>, number> = {
  body:     DBTypography.sizeMD,
  heading:  DBTypography.sizeLG,
  label:    DBTypography.sizeSM,
  subtle:   DBTypography.sizeSM,
  caption:  DBTypography.size2XS,
  overline: DBTypography.size2XS,
  brand:    DBTypography.sizeMD,
  disabled: DBTypography.sizeMD,
};

const VARIANT_WEIGHT: Record<NonNullable<DBTextProps["variant"]>, string> = {
  body:     DBTypography.weightRegular,
  heading:  DBTypography.weightBold,
  label:    DBTypography.weightMedium,
  subtle:   DBTypography.weightRegular,
  caption:  DBTypography.weightRegular,
  overline: DBTypography.weightMedium,
  brand:    DBTypography.weightBold,
  disabled: DBTypography.weightRegular,
};

const SIZE_MAP: Record<NonNullable<DBTextProps["size"]>, number> = {
  xs: DBTypography.size2XS,
  sm: DBTypography.sizeSM,
  md: DBTypography.sizeMD,
  lg: DBTypography.sizeLG,
  xl: DBTypography.sizeXL,
};

const WEIGHT_MAP: Record<NonNullable<DBTextProps["weight"]>, string> = {
  regular: DBTypography.weightRegular,
  medium:  DBTypography.weightMedium,
  bold:    DBTypography.weightBold,
};

function DBText(props: DBTextProps) {
  const { isDark, fontFamily: f } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const variant = props.variant ?? "body";

  const colorKey = VARIANT_COLOR[variant];
  const fontSize = props.size ? SIZE_MAP[props.size] : VARIANT_SIZE[variant];
  const fontWeightStr = props.weight ? WEIGHT_MAP[props.weight] : VARIANT_WEIGHT[variant];
  const weightKey = (props.weight ?? (fontWeightStr === DBTypography.weightBold ? "bold" : fontWeightStr === DBTypography.weightMedium ? "medium" : "regular")) as NonNullable<DBTextProps["weight"]>;

  const letterSpacing = variant === "overline" ? 0.8 : undefined;
  const textTransform = variant === "overline" ? "uppercase" as const : undefined;

  const { variant: _v, size: _s, weight: _w, style, children, ...rest } = props;

  return (
    <Text
      style={[
        {
          color: c[colorKey],
          fontSize,
          ...(Platform.OS === 'android' && f[weightKey] ? {} : { fontWeight: fontWeightStr as any }),
          fontFamily: f[weightKey],
          ...(letterSpacing !== undefined ? { letterSpacing } : {}),
          ...(textTransform !== undefined ? { textTransform } : {}),
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </Text>
  );
}

export default DBText;
`,

	/* ---- DBPage → SafeAreaView (built-in react-native) + StatusBar ---- */
	'page/page.tsx': `import React, { forwardRef } from "react";
import { View, StatusBar, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import DBText from "../text/text";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme } from "../../shared/tokens";
import { DBPageProps } from "./model";

function mkStyles(c: typeof DBTheme.light) {
  return {
    page: { flex: 1, backgroundColor: c.bg },
    headerSlot: {},
    main: { flex: 1 },
    footerSlot: {},
  };
}

function DBPageFn(props: DBPageProps, component: any) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;

  const styles = mkStyles(c);
  return (
    <SafeAreaView style={styles.page} ref={component}>
      <StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
      {props.header && <View style={styles.headerSlot}>{props.header}</View>}
      <View style={styles.main}>{props.children}</View>
      {props.footer && <View style={styles.footerSlot}>{props.footer}</View>}
    </SafeAreaView>
  );
}

const DBPage = forwardRef<View, DBPageProps>(DBPageFn);
export default DBPage;
`,

	/* ---- DBNavigation → themed horizontal scroll nav bar ---- */
	'navigation/navigation.tsx': `import React from "react";
import { View, ScrollView } from "react-native";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme } from "../../shared/tokens";

export type DBNavigationExtraProps = {
  children?: React.ReactNode;
  style?: any;
  direction?: "horizontal" | "vertical";
};

function DBNavigation(props: DBNavigationExtraProps) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const isVertical = props.direction === "vertical";

  const containerStyle = {
    backgroundColor: c.bg,
    borderBottomWidth: isVertical ? 0 : 1,
    borderBottomColor: c.border,
    borderRightWidth: isVertical ? 1 : 0,
    borderRightColor: c.border,
  };

  if (isVertical) {
    return (
      <View style={[containerStyle, { paddingVertical: 4 }, props.style]}>
        {props.children}
      </View>
    );
  }

  return (
    <View style={[containerStyle, props.style]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 4 }}
      >
        {props.children}
      </ScrollView>
    </View>
  );
}

export default DBNavigation;
`,

	/* ---- DBNavigationItem → nav item with flyout side panels ---- */
	'navigation-item/navigation-item.tsx': `import React, { useRef, useState } from "react";
import { Dimensions, Modal, Pressable, StyleSheet, View } from "react-native";
import DBText from "../text/text";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme } from "../../shared/tokens";

export type DBNavigationItemProps = {
  label?: string;
  active?: boolean;
  disabled?: boolean | string;
  onPress?: () => void;
  subNavigation?: React.ReactNode;
  subNavigationExpanded?: boolean | string;
  children?: React.ReactNode;
};

type PanelLevel = {
  items: React.ReactElement[];
  left: number;
  top: number;
  activeIdx: number | null;
};

function flattenChildren(node: React.ReactNode): React.ReactElement[] {
  if (!node) return [];
  if (Array.isArray(node)) return node.flatMap(flattenChildren);
  if (!React.isValidElement(node)) return [];
  if ((node as any).type === React.Fragment) return flattenChildren((node.props as any).children);
  return [node as React.ReactElement];
}

const PANEL_W = 200;
const PANEL_GAP = 4;

function DBNavigationItem(props: DBNavigationItemProps) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const triggerRef = useRef<View>(null);
  const [visible, setVisible] = useState(false);
  const [panels, setPanels] = useState<PanelLevel[]>(() => []);

  const hasDropdown = Boolean(props.subNavigation);
  const isExpanded = props.subNavigationExpanded !== undefined
    ? Boolean(props.subNavigationExpanded)
    : visible;

  function openDropdown() {
    if (!triggerRef.current) return;
    (triggerRef.current as any).measureInWindow((x: number, y: number, _w: number, h: number) => {
      const { width: winW } = Dimensions.get("window");
      const left = Math.max(8, Math.min(x, winW - PANEL_W - 8));
      const top = y + h;
      setPanels([{ items: flattenChildren(props.subNavigation), left, top, activeIdx: null }]);
      setVisible(true);
    });
  }

  function close() {
    setVisible(false);
    setPanels([]);
  }

  function handlePress() {
    if (hasDropdown) openDropdown();
    else props.onPress?.();
  }

  function handleItemPress(depthIdx: number, itemIdx: number, item: React.ReactElement) {
    const p = item.props as any;
    const subItems = flattenChildren(p.subNavigation);
    if (subItems.length > 0) {
      // Open sub-panel to the right (or left if overflows)
      const { width: winW } = Dimensions.get("window");
      const parentPanel = panels[depthIdx];
      let subLeft = parentPanel.left + PANEL_W + PANEL_GAP;
      if (subLeft + PANEL_W > winW - 8) {
        subLeft = parentPanel.left - PANEL_W - PANEL_GAP;
      }
      const subTop = parentPanel.top;
      // Mark active in parent, drop any deeper panels, push new one
      setPanels(prev => {
        const updated = prev.slice(0, depthIdx + 1).map((panel, i) =>
          i === depthIdx ? { ...panel, activeIdx: itemIdx } : panel
        );
        updated.push({ items: subItems, left: Math.max(8, subLeft), top: subTop, activeIdx: null });
        return updated;
      });
    } else {
      close();
      p.onPress?.();
    }
  }

  return (
    <>
      <Pressable
        ref={triggerRef}
        style={({ pressed }) => [
          styles.item,
          props.active ? { borderBottomColor: c.brandPrimary } : { borderBottomColor: "transparent" },
          pressed && { backgroundColor: c.bgSurface },
          Boolean(props.disabled) && { opacity: 0.4 },
        ]}
        onPress={handlePress}
        disabled={Boolean(props.disabled)}
        accessibilityRole="menuitem"
        accessibilityState={{ selected: props.active, expanded: hasDropdown ? isExpanded : undefined }}
      >
        <View style={styles.labelRow}>
          {props.label ? (
            <DBText weight={props.active ? "bold" : "regular"} style={{ color: props.active ? c.text : c.textMuted }}>
              {props.label}
            </DBText>
          ) : props.children}
          {hasDropdown && (
            <DBText style={[styles.chevron, { color: c.textMuted }]}>{isExpanded ? " ▴" : " ▾"}</DBText>
          )}
        </View>
      </Pressable>

      {hasDropdown && (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={close} />
          {(panels || []).map((panel, depth) => (
            <View
              key={depth}
              style={[styles.panel, {
                top: panel.top,
                left: panel.left,
                width: PANEL_W,
                backgroundColor: c.bg,
                borderColor: c.border,
                shadowColor: "#000",
              }]}
            >
              {panel.items.map((item, idx) => {
                const p = item.props as any;
                const label = p.label ?? p.children ?? "";
                const hasSub = flattenChildren(p.subNavigation).length > 0;
                const isActive = panel.activeIdx === idx;
                return (
                  <Pressable
                    key={idx}
                    style={({ pressed }) => [
                      styles.row,
                      { borderBottomColor: c.border },
                      (pressed || isActive) && { backgroundColor: c.bgSurface },
                    ]}
                    onPress={() => handleItemPress(depth, idx, item)}
                  >
                    <DBText
                      weight={p.active || isActive ? "bold" : "regular"}
                      style={{ color: c.text, flex: 1 }}
                    >
                      {label}
                    </DBText>
                    {hasSub && (
                      <DBText style={{ fontSize: 14, color: c.textMuted }}>›</DBText>
                    )}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </Modal>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  item: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 9, borderBottomWidth: 3 },
  labelRow: { flexDirection: "row", alignItems: "center" },
  chevron: { fontSize: 11 },
  panel: {
    position: "absolute",
    flexDirection: "column",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.14,
    shadowRadius: 12,
    elevation: 8,
    maxHeight: 420,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});

export default DBNavigationItem;
`,

	/* ---- DBIcon → @expo/vector-icons MaterialIcons ---- */
	'icon/icon.tsx': `import React, { forwardRef } from "react";
import { View, StyleSheet } from "react-native";
import DBText from "../text/text";
import { DBIconProps } from "./model";

// Lazy type-only import so @expo/vector-icons is NOT required at module load time.
// A top-level static import triggers Platform → TurboModuleRegistry.getEnforcing('PlatformConstants')
// before the bridgeless runtime is ready, crashing the app in Expo Go.
type MaterialIconsType = React.ComponentType<{ name: string; size: number; style?: any; accessibilityElementsHidden?: boolean }>;

/**
 * DBIcon wraps \`@expo/vector-icons\` MaterialIcons.
 * The \`icon\` prop is passed as the icon name. Non-matching names fall back to a Text placeholder.
 * The \`weight\` prop maps to icon size (16/20/24/32/48/64).
 */
function DBIconFn(props: DBIconProps, component: any) {
  // Lazy require: only loaded when the component renders, after the JS runtime is ready.
  const MaterialIcons: MaterialIconsType = require("@expo/vector-icons/MaterialIcons").default;

  const sizeMap: Record<string, number> = {
    "16": 16, "20": 20, "24": 24, "32": 32, "48": 48, "64": 64
  };
  const size = props.weight ? (sizeMap[props.weight] ?? 24) : 24;
  // DB UX uses underscore names (e.g. "arrow_forward"); MaterialIcons needs hyphens
  const iconName = (props.icon as string | undefined)?.replace(/_/g, '-');

  if (!iconName) {
    return props.text ? (
      <View ref={component}><DBText style={styles.text}>{props.text}</DBText></View>
    ) : (
      <View ref={component}>{props.children}</View>
    );
  }

  return (
    <MaterialIcons
      name={iconName}
      size={size}
      style={styles.icon}
      accessibilityElementsHidden
    />
  );
}

const styles = StyleSheet.create({
  icon: {},
  text: { fontSize: 14 }
});

const DBIcon = forwardRef<View, DBIconProps>(DBIconFn);
export default DBIcon;
`,

	/* ---- DBLink → expo-linking ---- */
	'link/link.tsx': `import React, { forwardRef } from "react";
import { Pressable, Text, View } from "react-native";
import DBText from "../text/text";
import * as Linking from "expo-linking";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme, DBTypography, DBColors } from "../../shared/tokens";
import { DBLinkProps } from "./model";

function MIIcon({ name, size, color, style }: { name: string; size: number; color: string; style?: any }) {
  const _mi = require("@expo/vector-icons/MaterialIcons");
  const MaterialIcons = _mi.default ?? _mi;
  // @expo/vector-icons MaterialIcons uses hyphenated names (e.g. arrow-forward, open-in-new)
  const normalizedName = name.replace(/_/g, "-");
  return <MaterialIcons name={normalizedName} size={size} color={color} style={style} accessibilityElementsHidden />;
}

function DBLinkFn(props: DBLinkProps, component: any) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;

  const variant = (props as any).variant ?? ""; // empty = default blue
  const size = (props as any).size ?? "medium";
  // content: "inline" | "internal" | "external"
  // "inline" = no arrow, renders as Text (sits inside parent Text)
  // "internal" = arrow_forward (default), "external" = open_in_new
  const content = (props as any).content ?? "internal";
  const leadingIcon = (props as any).icon as string | undefined;
  const isInline = content === "inline";
  const isSmall = size === "small";
  const isDisabled = Boolean(props.disabled);

  // default (no variant) = informational blue
  // adaptive = text color (black in light, white in dark)
  // brand = DB red
  const blueColor = isDark ? DBColors.informational.light : DBColors.informational.origin;
  const linkColor = variant === "brand"
    ? c.brandText
    : variant === "adaptive"
      ? c.text
      : blueColor;
  const activeColor = isDisabled ? c.textDisabled : linkColor;

  // trailing navigation arrow (only for non-inline)
  const trailingIconName = content === "external" ? "open_in_new" : "arrow_forward";

  async function handlePress() {
    if (props.href) {
      const canOpen = await Linking.canOpenURL(props.href);
      if (canOpen) await Linking.openURL(props.href);
    }
    if (props.onClick) (props.onClick as any)();
  }

  // Inline content: bare Text — sits naturally inside a parent Text, inherits font size
  if (isInline) {
    return (
      <Text
        onPress={isDisabled ? undefined : handlePress}
        accessibilityRole="link"
        style={{ color: activeColor, textDecorationLine: isDisabled ? "none" : "underline" }}
      >
        {props.text ?? props.children}
      </Text>
    );
  }

  // Block: [leading icon?] Label [trailing arrow]
  const fontSize = isSmall ? DBTypography.sizeSM : DBTypography.sizeMD;
  const iconSize = isSmall ? 14 : 16;

  return (
    <Pressable
      ref={component}
      onPress={handlePress}
      disabled={isDisabled}
      accessibilityRole="link"
      accessibilityLabel={props.text ?? String(props.children ?? "")}
      style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 4 }, pressed && { opacity: 0.7 }]}
    >
      {leadingIcon && (
        <MIIcon name={leadingIcon} size={iconSize} color={activeColor} />
      )}
      <DBText style={[
        { color: activeColor, textDecorationLine: "underline", fontSize },
        isDisabled && { textDecorationLine: "none" },
      ]}>
        {props.text ?? props.children}
      </DBText>
      <MIIcon name={trailingIconName} size={iconSize} color={activeColor} style={{ marginLeft: -2 }} />
    </Pressable>
  );
}

const DBLink = forwardRef<View, DBLinkProps>(DBLinkFn);
export default DBLink;
`,

	/* ---- DBButton → Pressable ---- */
	'button/button.tsx': `import React, { forwardRef } from "react";
import { Pressable, View } from "react-native";
import DBText from "../text/text";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme, DBTypography, DBSpacing, DBBorderRadius } from "../../shared/tokens";
import { DBButtonProps } from "./model";

function mkStyles(c: typeof DBTheme.light) {
  return {
    button: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      paddingVertical: DBSpacing.sm + 2,
      paddingHorizontal: DBSpacing.lg,
      borderRadius: DBBorderRadius.sm,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: "transparent",
    },
    filled: { backgroundColor: c.text, borderColor: c.text },
    ghost: { borderColor: "transparent" },
    brand: { backgroundColor: c.brandPrimary, borderColor: c.brandPrimary },
    buttonDisabled: { opacity: 0.4 },
    fullWidth: { width: "100%" as const },
    label: { fontSize: DBTypography.sizeSM, color: c.text, fontWeight: DBTypography.weightMedium },
    labelInverted: { color: c.bg },
    labelDisabled: { color: c.textDisabled },
  };
}

function DBButtonFn(props: DBButtonProps, component: any) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;

  const styles = mkStyles(c);

  function handlePress(event: any) {
    if (props.onClick) (props.onClick as any)(event);
  }

  const label = props.text ?? props.children;

  return (
    <Pressable
      ref={component}
      onPress={handlePress}
      disabled={Boolean(props.disabled)}
      accessibilityRole="button"
      accessibilityLabel={typeof label === "string" ? label : undefined}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      style={({ pressed }) => [
        styles.button,
        props.variant === "filled" && styles.filled,
        props.variant === "ghost" && styles.ghost,
        props.variant === "brand" && styles.brand,
        Boolean(props.disabled) && styles.buttonDisabled,
        props.width === "full" && styles.fullWidth,
        pressed && !Boolean(props.disabled) && { opacity: 0.75 },
      ]}
    >
      {typeof label === "string" ? (
        <DBText
          style={[
            styles.label,
            (props.variant === "filled" || props.variant === "brand") && styles.labelInverted,
            Boolean(props.disabled) && !(props.variant === "filled" || props.variant === "brand") && styles.labelDisabled,
          ]}
        >
          {label}
        </DBText>
      ) : (
        label
      )}
    </Pressable>
  );
}

const DBButton = forwardRef<View, DBButtonProps>(DBButtonFn);
export default DBButton;
`,

	/* ---- DBCustomButton → Pressable ---- */
	'custom-button/custom-button.tsx': `import React, { forwardRef } from "react";
import { Pressable, View, StyleSheet } from "react-native";
import DBText from "../text/text";
import { DBCustomButtonProps } from "./model";

function DBCustomButtonFn(props: DBCustomButtonProps, component: any) {
  function handlePress(event: any) {
    if ((props as any).onClick) (props as any).onClick(event);
  }

  return (
    <Pressable
      ref={component}
      onPress={handlePress}
      disabled={Boolean((props as any).disabled)}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      accessibilityRole="button"
    >
      {props.children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 4
  },
  pressed: { opacity: 0.7 }
});

const DBCustomButton = forwardRef<View, DBCustomButtonProps>(DBCustomButtonFn);
export default DBCustomButton;
`,

	/* ---- DBHeader → SafeAreaView (built-in) ---- */
	'header/header.tsx': `import React, { forwardRef } from "react";
import { View, StatusBar } from "react-native";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme } from "../../shared/tokens";
import DBButton from "../button/button";
import DBDrawer from "../drawer/drawer";
import { DBHeaderProps } from "./model";

function mkStyles(c: typeof DBTheme.light) {
  return {
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      paddingHorizontal: 16,
      paddingVertical: 12,
      minHeight: 56,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      backgroundColor: c.bg,
    },
    brand: { marginRight: 12, flexShrink: 0 as const },
    navContainer: { flex: 1, overflow: "hidden" as const },
    actions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4, flexShrink: 0 as const, marginLeft: 8 },
  };
}

function DBHeaderFn(props: DBHeaderProps, component: any) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const styles = mkStyles(c);
  const hasDrawer = props.onToggle !== undefined;

  function handleToggle() {
    const open = !Boolean(props.drawerOpen);
    if (props.onToggle) props.onToggle(open);
  }

  return (
    <View style={{ backgroundColor: c.bg }}>
      <StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
      <View style={styles.header} ref={component}>
        {props.brand && <View style={styles.brand}>{props.brand}</View>}
        {/* Only show inline nav when there is no drawer — avoid squishing */}
        {!hasDrawer && <View style={styles.navContainer}>{props.children}</View>}
        {hasDrawer && <View style={styles.navContainer} />}
        <View style={styles.actions}>
          {props.primaryAction}
          {props.secondaryAction}
          {hasDrawer && (
            <DBButton variant="ghost" noText icon="menu" onClick={handleToggle}>
              {props.burgerMenuLabel ?? "Menu"}
            </DBButton>
          )}
        </View>
      </View>
      {hasDrawer && (
        <DBDrawer
          open={Boolean(props.drawerOpen)}
          onClose={handleToggle}
          closeButtonText={props.closeButtonText}
        >
          <View>{props.children}</View>
          {props.metaNavigation && <View>{props.metaNavigation}</View>}
        </DBDrawer>
      )}
    </View>
  );
}

const DBHeader = forwardRef<View, DBHeaderProps>(DBHeaderFn);
export default DBHeader;
`,

	/* ---- DBDrawer → Modal + built-in Animated slide ---- */
	'drawer/drawer.tsx': `import React, { forwardRef, useEffect, useRef } from "react";
import {
  Modal,
  View,
  Pressable,
  ScrollView,
  Animated,
  StyleSheet,
  Dimensions,
} from "react-native";
import DBText from "../text/text";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme } from "../../shared/tokens";
import { DBDrawerProps } from "./model";

const DURATION = 260;
const DRAWER_SIZE = Math.min(Math.round(Dimensions.get("window").width * 0.82), 480);
const OFF = 800; // guaranteed off-screen offset

function DBDrawerFn(props: DBDrawerProps, component: any) {
  const { isDark } = useDBFont();
  const c = isDark ? DBTheme.dark : DBTheme.light;
  const direction = props.direction ?? "left";
  const isOpen = Boolean(props.open);
  const isVertical = direction === "up" || direction === "down";

  const offset =
    direction === "right" ?  DRAWER_SIZE :
    direction === "down"  ?  OFF :
    direction === "up"    ? -OFF :
    -DRAWER_SIZE;

  const anim = useRef(new Animated.Value(isOpen ? 0 : offset)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: isOpen ? 0 : offset,
      duration: DURATION,
      useNativeDriver: true,
    }).start();
  }, [isOpen]);

  const transform = isVertical ? [{ translateY: anim }] : [{ translateX: anim }];

  // Panel anchored absolutely to its edge; fills the full cross-axis
  const panelPos =
    direction === "right" ? { right: 0, top: 0, bottom: 0, width: DRAWER_SIZE } :
    direction === "down"  ? { left: 0, right: 0, bottom: 0, maxHeight: "60%" as any } :
    direction === "up"    ? { left: 0, right: 0, top: 0, maxHeight: "60%" as any } :
    /* left */              { left: 0, top: 0, bottom: 0, width: DRAWER_SIZE };

  return (
    <Modal
      visible={isOpen}
      transparent
      animationType="none"
      onRequestClose={() => props.onClose?.()}
    >
      {/* Dimmed backdrop — rendered first (behind panel) */}
      <Pressable
        style={[StyleSheet.absoluteFill, styles.backdrop]}
        onPress={() => props.backdrop !== "none" && props.onClose?.()}
      />

      {/* Drawer panel — rendered second (on top of backdrop) */}
      <Animated.View
        ref={component}
        style={[
          { position: "absolute" },
          panelPos,
          {
            backgroundColor: c.bgElevated,
            shadowColor: c.shadowColor,
            shadowOffset: {
              width:  direction === "right" ? -2 : (isVertical ? 0 : 2),
              height: direction === "down"  ? -2 : (direction === "up" ? 2 : 0),
            },
            shadowOpacity: 0.25,
            shadowRadius: 8,
            elevation: 8,
          },
          { transform },
        ]}
      >
        <View style={[styles.drawerHeader, { borderBottomColor: c.border }]}>
          <Pressable
            onPress={() => props.onClose?.()}
            accessibilityLabel={props.closeButtonText ?? "Close"}
            accessibilityRole="button"
            style={({ pressed }) => [pressed && { opacity: 0.7 }]}
          >
            <DBText style={[styles.closeBtn, { color: c.text }]}>✕</DBText>
          </Pressable>
        </View>
        <ScrollView style={styles.content}>{props.children}</ScrollView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: "rgba(0,0,0,0.45)" },
  drawerHeader: {
    padding: 16,
    flexDirection: "row",
    justifyContent: "flex-end",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  closeBtn: { fontSize: 20 },
  content: { flex: 1, padding: 16 },
});

const DBDrawer = forwardRef<View, DBDrawerProps>(DBDrawerFn);
export default DBDrawer;
`,

	/* ---- DBTooltip → expo-blur backdrop ---- */
	'tooltip/tooltip.tsx': `import React, { forwardRef, useState, useRef } from "react";
import {
  Dimensions,
  Modal,
  View,
  Pressable,
  StyleSheet,
} from "react-native";
import DBText from "../text/text";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme } from "../../shared/tokens";
import { DBTooltipProps } from "./model";

type Placement = "top" | "bottom" | "left" | "right";

const TIP_W = 220;

function extractText(node: any): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(extractText).join(" ").trim();
  if (node.props?.children !== undefined) return extractText(node.props.children);
  return "";
}

function DBTooltipFn(props: DBTooltipProps, component: any) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const [visible, setVisible] = useState(false);
  const triggerRef = useRef<View>(null);
  const [pos, setPos] = useState({ x: 0, y: 0, w: 0, h: 0 });
  // Actual measured tooltip height — starts at 0 so first layout fires reposition
  const [tipH, setTipH] = useState(0);

  const childArray = React.Children.toArray(props.children);
  const trigger = childArray[0];

  const rawContent: string =
    (props as any).tooltipText ??
    (props as any).content ??
    (props as any).text ??
    (childArray[1] ? extractText(childArray[1]) : "");

  function show() {
    if (!rawContent) return;
    triggerRef.current
      ? (triggerRef.current as any).measureInWindow((x: number, y: number, w: number, h: number) => {
          setPos({ x, y, w, h });
          setVisible(true);
        })
      : setVisible(true);
  }

  // Strategy A: inject onPress/onClick for interactive children (DBButton etc.)
  const triggerWithHandler = React.isValidElement(trigger)
    ? React.cloneElement(trigger as React.ReactElement<any>, {
        onPress: (e: any) => {
          (trigger as React.ReactElement<any>).props?.onPress?.(e);
          (trigger as React.ReactElement<any>).props?.onClick?.(e);
          show();
        },
        onClick: (e: any) => {
          (trigger as React.ReactElement<any>).props?.onClick?.(e);
          show();
        },
      })
    : trigger;

  const placement: Placement = ((props as any).placement ?? "bottom") as Placement;
  const { width: winW } = Dimensions.get("window");
  const GAP = 6;

  function positionStyle(measuredH: number) {
    const h = measuredH || 36; // sensible fallback before first layout
    const { x, y, w } = pos;
    const cx = x + w / 2;
    const left = Math.max(8, Math.min(cx - TIP_W / 2, winW - TIP_W - 8));
    switch (placement) {
      case "top":
        return { top: Math.max(8, pos.y - h - GAP), left };
      case "left":
        return { top: Math.max(8, pos.y + pos.h / 2 - h / 2), right: winW - x + GAP, maxWidth: TIP_W };
      case "right":
        return { top: Math.max(8, pos.y + pos.h / 2 - h / 2), left: x + w + GAP, maxWidth: TIP_W };
      default:
        return { top: pos.y + pos.h + GAP, left };
    }
  }

  return (
    <View style={styles.container} ref={component}>
      {/* Strategy B: outer Pressable for non-interactive children (DBBadge etc.) */}
      <Pressable onPress={show}>
        <View ref={triggerRef} pointerEvents="box-none">
          {triggerWithHandler}
        </View>
      </Pressable>
      {rawContent ? (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setVisible(false)}>
            <View
              style={[styles.tooltip, { backgroundColor: c.text, shadowColor: "#000" }, positionStyle(tipH)]}
              onLayout={(e) => setTipH(e.nativeEvent.layout.height)}
              pointerEvents="none"
            >
              <DBText style={[styles.tooltipText, { color: c.bg }]}>{rawContent}</DBText>
            </View>
          </Pressable>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: "flex-start" },
  tooltip: {
    position: "absolute",
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    maxWidth: TIP_W,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 8,
  },
  tooltipText: { fontSize: 13, lineHeight: 18 },
});

const DBTooltip = forwardRef<View, DBTooltipProps>(DBTooltipFn);
export default DBTooltip;
`,

	/* ---- DBPopover → anchored floating panel ---- */
	'popover/popover.tsx': `import React, { forwardRef, useState, useEffect } from "react";
import {
  Modal,
  View,
  Pressable,
  ScrollView,
  StyleSheet,
} from "react-native";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme, DBBorderRadius } from "../../shared/tokens";
import { DBPopoverProps } from "./model";

function mkStyles(c: typeof DBTheme.light) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)" },
    centeredWrap: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 24 },
    panel: {
      backgroundColor: c.bg,
      borderRadius: DBBorderRadius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      padding: 16,
      width: "100%",
      maxWidth: 360,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.15,
      shadowRadius: 16,
      elevation: 10,
    },
  });
}

function DBPopoverFn(props: DBPopoverProps, component: any) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const [visible, setVisible] = useState(Boolean(props.open));

  useEffect(() => { setVisible(Boolean(props.open)); }, [props.open]);

  function handleClose() {
    setVisible(false);
    (props as any).onClose?.();
  }

  const styles = mkStyles(c);

  return (
    <View ref={component}>
      <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
        {/* Tap outside the panel to dismiss — no dark tint */}
        <Pressable style={styles.backdrop} onPress={handleClose}>
          <View style={styles.centeredWrap}>
            <Pressable onPress={() => {/* absorb taps inside panel */}}>
              <View style={styles.panel}>
                <ScrollView showsVerticalScrollIndicator={false}>
                  {props.children}
                </ScrollView>
              </View>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const DBPopover = forwardRef<View, DBPopoverProps>(DBPopoverFn);
export default DBPopover;
`,

	/* ---- DBAccordion → react-native-reanimated ---- */
	'accordion/accordion.tsx': `import React, { forwardRef, useState, useId } from "react";
import { View, StyleSheet } from "react-native";
import DBText from "../text/text";
import DBAccordionItem from "../accordion-item/accordion-item";
import { DBAccordionItemDefaultProps } from "../accordion-item/model";
import { DBAccordionProps } from "./model";

function DBAccordionFn(props: DBAccordionProps, component: any) {
  const uuid = useId();
  const name = props.name ?? \`acc-\${uuid}\`;
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  function convertItems(): DBAccordionItemDefaultProps[] {
    try {
      if (typeof props.items === "string") return JSON.parse(props.items);
      return (props.items as DBAccordionItemDefaultProps[]) ?? [];
    } catch { return []; }
  }

  const items = convertItems();

  function handleToggle(index: number) {
    setOpenIndex((prev) => {
      const next = prev === index ? null : index;
      return next;
    });
  }

  return (
    <View style={styles.container} ref={component}>
      {items.length > 0
        ? items.map((item, i) => (
            <DBAccordionItem
              key={\`\${name}-\${i}\`}
              open={props.behavior === "single" ? openIndex === i : (item as any).open}
              onToggle={() => handleToggle(i)}
              {...item}
            />
          ))
        : props.children}
    </View>
  );
}

const styles = StyleSheet.create({ container: {} });

const DBAccordion = forwardRef<View, DBAccordionProps>(DBAccordionFn);
export default DBAccordion;
`,

	/* ---- DBAccordionItem → built-in Animated expand/collapse ---- */
	'accordion-item/accordion-item.tsx': `import React, { forwardRef, useState, useEffect, useRef } from "react";
import { View, Pressable, Animated, StyleSheet } from "react-native";
import DBText from "../text/text";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme } from "../../shared/tokens";
import { DBAccordionItemProps } from "./model";

function mkStyles(c: typeof DBTheme.light) {
  return {
    container: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingVertical: 14,
      paddingHorizontal: 16,
    },
    headerPressed: { backgroundColor: c.bgSurface },
    title: { fontSize: 16, fontWeight: "600" as const, flex: 1, color: c.text },
    chevron: { fontSize: 12, color: c.textMuted },
    body: { overflow: "hidden" as const },
    bodyInner: { paddingHorizontal: 16, paddingBottom: 14 },
    bodyText: { fontSize: 13, color: c.textMuted },
  };
}

function DBAccordionItemFn(props: DBAccordionItemProps & {
  onToggle?: () => void;
}, component: any) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const [open, setOpen] = useState(Boolean((props as any).open ?? props.defaultOpen));
  const anim = useRef(new Animated.Value(open ? 1 : 0)).current;

  useEffect(() => {
    const next = Boolean((props as any).open);
    setOpen(next);
    Animated.timing(anim, {
      toValue: next ? 1 : 0,
      duration: 220,
      useNativeDriver: false,
    }).start();
  }, [(props as any).open]);

  function handlePress() {
    const next = !open;
    setOpen(next);
    Animated.timing(anim, {
      toValue: next ? 1 : 0,
      duration: 220,
      useNativeDriver: false,
    }).start();
    if (props.onToggle) props.onToggle();
    if ((props as any).onOpen && next) (props as any).onOpen();
    if ((props as any).onClose && !next) (props as any).onClose();
  }

  const maxHeight = anim.interpolate({ inputRange: [0, 1], outputRange: [0, 2000] });
  const styles = mkStyles(c);

  return (
    <View style={styles.container} ref={component}>
      <Pressable
        style={({ pressed }) => [styles.header, pressed && styles.headerPressed]}
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <DBText style={styles.title}>{props.headlinePlain ?? props.text}</DBText>
        <DBText style={styles.chevron}>{open ? "▴" : "▾"}</DBText>
      </Pressable>
      <Animated.View style={[styles.body, { maxHeight, opacity: anim }]}>
        <View style={styles.bodyInner}>
          {(props as any).content
            ? <DBText style={styles.bodyText}>{(props as any).content}</DBText>
            : props.children}
        </View>
      </Animated.View>
    </View>
  );
}

const DBAccordionItem = forwardRef<View, DBAccordionItemProps & { open?: boolean; onOpen?: () => void; onClose?: () => void; onToggle?: () => void }>(DBAccordionItemFn);
export default DBAccordionItem;
`,

	/* ---- DBTabs → ScrollView tab bar ---- */
	'tabs/tabs.tsx': `import React, { forwardRef, useState, useId } from "react";
import { View, ScrollView, Pressable, StyleSheet } from "react-native";
import DBText from "../text/text";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme } from "../../shared/tokens";
import { DBSimpleTabProps, DBTabsProps } from "./model";

function mkStyles(c: typeof DBTheme.light) {
  return {
    container: { flex: 1 },
    tabBarH: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    tabBarV: { flexDirection: "column" as const, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: c.border },
    tabBarHRow: { flexDirection: "row" as const },
    tab: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 2,
      borderBottomColor: "transparent",
    },
    tabFull: { flex: 1 },
    tabActive: { borderBottomColor: c.brandPrimary },
    tabText: { fontSize: 14, color: c.textMuted },
    tabTextActive: { color: c.text, fontWeight: "600" as const },
    tabTextCenter: { textAlign: "center" as const },
    panel: { flex: 1, padding: 12 },
  };
}

function DBTabsFn(props: DBTabsProps, component: any) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const uuid = useId();
  const [selectedIndex, setSelectedIndex] = useState(0);

  const tabs: DBSimpleTabProps[] = (() => {
    try {
      if (typeof props.tabs === "string") return JSON.parse(props.tabs);
      return (props.tabs as DBSimpleTabProps[]) ?? [];
    } catch { return []; }
  })();

  const isHorizontal = !props.orientation || props.orientation === "horizontal";
  const isFull = (props as any).width === "full";
  const alignment: "start" | "center" = (props as any).alignment ?? "start";

  function handleTabPress(index: number) {
    setSelectedIndex(index);
    if (props.onIndexChange) props.onIndexChange(index);
    if (props.onTabSelect) (props.onTabSelect as any)(index);
  }

  const styles = mkStyles(c);

  const tabItems = tabs.map((tab, index) => (
    <Pressable
      key={String(props.name ?? uuid) + index}
      style={({ pressed }) => [
        styles.tab,
        isFull && styles.tabFull,
        selectedIndex === index && styles.tabActive,
        pressed && { opacity: 0.7 },
      ]}
      onPress={() => handleTabPress(index)}
      accessibilityRole="tab"
      accessibilityState={{ selected: selectedIndex === index }}
    >
      <DBText style={[
        styles.tabText,
        selectedIndex === index && styles.tabTextActive,
        alignment === "center" && styles.tabTextCenter,
      ]}>
        {tab.label}
      </DBText>
    </Pressable>
  ));

  return (
    <View style={styles.container} ref={component}>
      <View style={styles.tabBarH}>
        {isFull ? (
          <View style={styles.tabBarHRow}>
            {tabItems}
            {props.children}
          </View>
        ) : (
          <ScrollView
            horizontal={isHorizontal}
            contentContainerStyle={isHorizontal ? styles.tabBarHRow : undefined}
            style={!isHorizontal ? styles.tabBarV : undefined}
            showsHorizontalScrollIndicator={false}
          >
            {tabItems}
            {props.children}
          </ScrollView>
        )}
      </View>
      {tabs[selectedIndex] && (
        <View style={styles.panel}>
          {tabs[selectedIndex].content
            ? <DBText>{tabs[selectedIndex].content}</DBText>
            : tabs[selectedIndex].children}
        </View>
      )}
    </View>
  );
}

const DBTabs = forwardRef<View, DBTabsProps>(DBTabsFn);
export default DBTabs;
`,

	/* ---- DBSwitch → RN Switch (built-in) ---- */
	'switch/switch.tsx': `import React, { forwardRef, useId } from "react";
import { View, Switch as RNSwitch } from "react-native";
import DBText from "../text/text";
import DBInfotext from "../infotext/infotext";
import { DEFAULT_VALID_MESSAGE } from "../../shared/constants";
import { stringPropVisible } from "../../utils";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme, DBTypography, DBSpacing } from "../../shared/tokens";
import { DBSwitchProps } from "./model";

function mkStyles(c: typeof DBTheme.light) {
  return {
    container: { marginVertical: DBSpacing.sm },
    row: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const },
    label: { flex: 1, fontSize: DBTypography.sizeSM, color: c.text },
  };
}

function DBSwitchFn(props: DBSwitchProps, component: any) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;

  const styles = mkStyles(c);
  const uuid = useId();

  function hasValidState() {
    return !!(props.validMessage ?? props.validation === "valid");
  }

  return (
    <View style={styles.container} ref={component}>
      <View style={styles.row}>
        {(props.label || props.children) && (
          <DBText style={styles.label}>{props.label ?? props.children}</DBText>
        )}
        <RNSwitch
          value={Boolean(props.checked)}
          onValueChange={(val) => {
            if (props.onChange) (props.onChange as any)({ target: { checked: val, value: val ? "on" : "off" } });
          }}
          disabled={Boolean(props.disabled)}
          trackColor={{ false: c.switchTrack, true: c.brandPrimary }}
          thumbColor={c.bg}
          accessibilityLabel={props.label ?? String(props.children ?? "")}
        />
      </View>
      {stringPropVisible(props.message, props.showMessage) && (
        <DBInfotext size="small" semantic="adaptive">{props.message}</DBInfotext>
      )}
      {hasValidState() && (
        <DBInfotext size="small" semantic="successful">
          {props.validMessage ?? DEFAULT_VALID_MESSAGE}
        </DBInfotext>
      )}
    </View>
  );
}

const DBSwitch = forwardRef<View, DBSwitchProps>(DBSwitchFn);
export default DBSwitch;
`,

	/* ---- DBCheckbox → Pressable ---- */
	'checkbox/checkbox.tsx': `import React, { forwardRef, useState } from "react";
import { View, Pressable } from "react-native";
import DBText from "../text/text";
import DBInfotext from "../infotext/infotext";
import { DEFAULT_VALID_MESSAGE } from "../../shared/constants";
import { stringPropVisible } from "../../utils";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme, DBTypography, DBSpacing, DBBorderRadius } from "../../shared/tokens";
import { DBCheckboxProps } from "./model";

type MaterialIconsType = React.ComponentType<{ name: string; size: number; color?: string; accessibilityElementsHidden?: boolean }>;

function mkStyles(c: typeof DBTheme.light) {
  return {
    container: { marginVertical: DBSpacing.xs },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: DBSpacing.sm },
    box: { width: 20, height: 20, borderWidth: 2, borderColor: c.borderStrong, borderRadius: DBBorderRadius.sm - 1, alignItems: "center" as const, justifyContent: "center" as const },
    boxChecked: { backgroundColor: c.text, borderWidth: 0 },
    boxIndeterminate: { backgroundColor: c.text, borderWidth: 0 },
    boxDisabled: { borderColor: c.textDisabled, backgroundColor: c.bgSurface },
    label: { fontSize: DBTypography.sizeSM, color: c.text, flex: 1 },
    labelDisabled: { color: c.textDisabled },
  };
}

function DBCheckboxFn(props: DBCheckboxProps, component: any) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;

  const styles = mkStyles(c);
  const [internal, setInternal] = useState(Boolean((props as any).defaultChecked));
  const checked = props.checked !== undefined ? Boolean(props.checked) : internal;
  const indeterminate = Boolean((props as any).indeterminate);

  // Lazy require — avoids PlatformConstants crash on startup
  const _mi = require("@expo/vector-icons/MaterialIcons");
  const MaterialIcons: MaterialIconsType = _mi.default ?? _mi;

  function handlePress() {
    if (Boolean(props.disabled)) return;
    const next = !checked;
    setInternal(next);
    if (props.onChange) (props.onChange as any)({ target: { checked: next, value: next ? "on" : "off" } });
  }

  return (
    <View style={styles.container} ref={component}>
      <Pressable
        style={({ pressed }) => [styles.row, pressed && { opacity: 0.75 }]}
        onPress={handlePress}
        disabled={Boolean(props.disabled)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled: Boolean(props.disabled) }}
      >
        <View style={[styles.box, checked && styles.boxChecked, indeterminate && styles.boxIndeterminate, Boolean(props.disabled) && styles.boxDisabled]}>
          {checked && (
            <MaterialIcons name="check" size={14} color={c.bg} accessibilityElementsHidden />
          )}
          {!checked && indeterminate && (
            <MaterialIcons name="remove" size={14} color={c.bg} accessibilityElementsHidden />
          )}
        </View>
        {(props.label || props.children) && (
          <DBText style={[styles.label, Boolean(props.disabled) && styles.labelDisabled]}>
            {props.label ?? props.children}
          </DBText>
        )}
      </Pressable>
      {stringPropVisible(props.message, props.showMessage) && (
        <DBInfotext size="small" semantic="adaptive">{props.message}</DBInfotext>
      )}
      {(props.validMessage ?? props.validation === "valid") && (
        <DBInfotext size="small" semantic="successful">
          {props.validMessage ?? DEFAULT_VALID_MESSAGE}
        </DBInfotext>
      )}
    </View>
  );
}

const DBCheckbox = forwardRef<View, DBCheckboxProps>(DBCheckboxFn);
export default DBCheckbox;
`,

	/* ---- DBRadio → Pressable ---- */
	'radio/radio.tsx': `import React, { forwardRef } from "react";
import { View, Pressable } from "react-native";
import DBText from "../text/text";
import DBInfotext from "../infotext/infotext";
import { DEFAULT_VALID_MESSAGE } from "../../shared/constants";
import { stringPropVisible } from "../../utils";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme, DBTypography, DBSpacing } from "../../shared/tokens";
import { DBRadioProps } from "./model";

function mkStyles(c: typeof DBTheme.light) {
  return {
    container: { marginVertical: DBSpacing.xs },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: DBSpacing.sm },
    // Ring 20dp, border 2dp → content area 16dp. Dot 8dp → offset (16-8)/2 = 4dp.
    // 4dp × any common density (0.75/1/1.5/2/3/4) always yields an integer pixel count.
    // A 10dp dot gives 3dp offset = 4.5px at 1.5× → non-integer → visual misalignment.
    wrap: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: c.borderStrong, justifyContent: "center" as const, alignItems: "center" as const },
    wrapDisabled: { borderColor: c.textDisabled },
    inner: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.brandPrimary },
    label: { fontSize: DBTypography.sizeSM, color: c.text, flex: 1 },
    labelDisabled: { color: c.textDisabled },
  };
}

function DBRadioFn(props: DBRadioProps, component: any) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;

  const styles = mkStyles(c);
  const checked = Boolean(props.checked);

  function handlePress() {
    if (Boolean(props.disabled)) return;
    if (props.onChange) (props.onChange as any)({ target: { checked: true, value: "on" } });
  }

  return (
    <View style={styles.container} ref={component}>
      <Pressable
        style={({ pressed }) => [styles.row, pressed && { opacity: 0.75 }]}
        onPress={handlePress}
        disabled={Boolean(props.disabled)}
        accessibilityRole="radio"
        accessibilityState={{ checked, disabled: Boolean(props.disabled) }}
      >
        <View style={[styles.wrap, Boolean(props.disabled) && styles.wrapDisabled]}>
          {checked && <View style={styles.inner} />}
        </View>
        {(props.label || props.children) && (
          <DBText style={[styles.label, Boolean(props.disabled) && styles.labelDisabled]}>
            {props.label ?? props.children}
          </DBText>
        )}
      </Pressable>
      {stringPropVisible((props as any).message, (props as any).showMessage) && (
        <DBInfotext size="small" semantic="adaptive">{(props as any).message}</DBInfotext>
      )}
    </View>
  );
}

const DBRadio = forwardRef<View, DBRadioProps>(DBRadioFn);
export default DBRadio;
`,

	/* ---- DBSelect → Modal picker ---- */
	'select/model.ts': `export type DBSelectOptionType = { value?: string; label?: string; disabled?: boolean };
export type DBSelectDefaultProps = {
  multiple?: boolean;
  /** Options as label/value objects or plain strings */
  options?: DBSelectOptionType[] | string[];
  value?: string | string[];
  placeholder?: string;
  label?: string;
  disabled?: boolean | string;
  required?: boolean | string;
  invalid?: boolean | string;
  valid?: boolean | string;
  message?: string;
  validMessage?: string;
  invalidMessage?: string;
  onChange?: (v: string | string[]) => void;
};
import { GlobalProps } from "../../shared/model";
export type DBSelectProps = DBSelectDefaultProps & GlobalProps;
`,

	'select/select.tsx': `import React, { forwardRef, useState, useId } from "react";
import { View, Pressable, Modal, FlatList } from "react-native";
import DBText from "../text/text";
import DBInfotext from "../infotext/infotext";
import { DEFAULT_VALID_MESSAGE, DEFAULT_INVALID_MESSAGE } from "../../shared/constants";
import { stringPropVisible } from "../../utils";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme, DBTypography, DBSpacing, DBBorderRadius } from "../../shared/tokens";
import { DBSelectOptionType, DBSelectProps } from "./model";

function mkStyles(c: typeof DBTheme.light) {
  return {
    container: { marginVertical: DBSpacing.xs },
    label: { fontSize: DBTypography.size2XS, color: c.textMuted, marginBottom: DBSpacing.xs },
    trigger: { flexDirection: "row" as const, alignItems: "center" as const, borderWidth: 1, borderColor: c.borderStrong, borderRadius: DBBorderRadius.sm, padding: 10, backgroundColor: c.inputBg },
    triggerDisabled: { borderColor: c.textDisabled, backgroundColor: c.bgSurface },
    triggerText: { flex: 1, fontSize: DBTypography.sizeSM, color: c.text },
    arrow: { fontSize: DBTypography.sizeSM, color: c.textMuted },
    backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.3)", justifyContent: "flex-end" as const },
    sheet: { backgroundColor: c.inputBg, borderTopLeftRadius: DBBorderRadius.lg, borderTopRightRadius: DBBorderRadius.lg, maxHeight: "50%" as any, padding: DBSpacing.sm },
    option: { padding: 14, borderBottomWidth: 1, borderBottomColor: c.border },
    optionSelected: { backgroundColor: c.bgElevated },
    optionText: { fontSize: DBTypography.sizeMD, color: c.text },
    optionTextSelected: { fontWeight: DBTypography.weightBold, color: c.brandPrimary },
    optionPressed: { backgroundColor: c.bgElevated },
  };
}

function DBSelectFn(props: DBSelectProps, component: any) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(String(props.value ?? ""));

  const options: any[] = Array.isArray(props.options) ? props.options : [];
  const selectedLabel = options.find((o) =>
    typeof o === "string" ? o === selected : (o as any).value === selected
  );
  const display =
    typeof selectedLabel === "string"
      ? selectedLabel
      : (selectedLabel as any)?.label ?? selected ?? props.placeholder ?? "";

  function handleSelect(option: DBSelectOptionType) {
    const val = typeof option === "string" ? option : (option as any).value ?? "";
    setSelected(val);
    setOpen(false);
    if (props.onChange) (props.onChange as any)({ target: { value: val } });
  }

  const styles = mkStyles(c);

  return (
    <View style={styles.container} ref={component}>
      {props.label && <DBText style={styles.label}>{props.label}</DBText>}
      <Pressable
        style={({ pressed }) => [styles.trigger, Boolean(props.disabled) && styles.triggerDisabled, pressed && { opacity: 0.8 }]}
        onPress={() => !Boolean(props.disabled) && setOpen(true)}
        accessibilityRole="combobox"
        accessibilityState={{ expanded: open, disabled: Boolean(props.disabled) }}
      >
        <DBText style={styles.triggerText}>{display}</DBText>
        <DBText style={styles.arrow}>▾</DBText>
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            <FlatList
              data={options}
              keyExtractor={(item, i) => typeof item === "string" ? item : ((item as any).value ?? String(i))}
              renderItem={({ item }) => {
                const val = typeof item === "string" ? item : (item as any).value ?? "";
                const lbl = typeof item === "string" ? item : (item as any).label ?? val;
                return (
                  <Pressable
                    style={({ pressed }) => [styles.option, val === selected && styles.optionSelected, pressed && styles.optionPressed]}
                    onPress={() => handleSelect(item)}
                  >
                    <DBText style={[styles.optionText, val === selected && styles.optionTextSelected]}>{lbl}</DBText>
                  </Pressable>
                );
              }}
            />
          </View>
        </Pressable>
      </Modal>
      {props.message && (
        <DBInfotext size="small" semantic="adaptive">{props.message}</DBInfotext>
      )}
    </View>
  );
}

const DBSelect = forwardRef<View, DBSelectProps>(DBSelectFn);
export default DBSelect;
`,

	/* ---- DBInput → TextInput ---- */
	'input/input.tsx': `import React, { forwardRef, useState, useEffect } from "react";
import { View, TextInput as RNTextInput } from "react-native";
import DBText from "../text/text";
import DBInfotext from "../infotext/infotext";
import { DEFAULT_INVALID_MESSAGE, DEFAULT_VALID_MESSAGE } from "../../shared/constants";
import { stringPropVisible } from "../../utils";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme, DBColors, DBTypography, DBSpacing, DBBorderRadius } from "../../shared/tokens";
import { DBInputProps } from "./model";

function mkStyles(c: typeof DBTheme.light) {
  return {
    container: { marginVertical: DBSpacing.xs },
    label: { fontSize: DBTypography.size2XS, color: c.textMuted, marginBottom: DBSpacing.xs },
    required: { color: c.brandPrimary },
    input: { borderWidth: 1, borderColor: c.borderStrong, borderRadius: DBBorderRadius.sm, padding: 10, fontSize: DBTypography.sizeSM, backgroundColor: c.inputBg, color: c.text },
    focused: { borderColor: DBColors.informational.origin, borderWidth: 2 },
    invalid: { borderColor: DBColors.critical.origin },
    valid: { borderColor: DBColors.successful.origin },
    disabled: { borderColor: c.textDisabled, backgroundColor: c.bgSurface, color: c.textDisabled },
    description: { fontSize: DBTypography.size2XS, color: c.textSubtle, marginTop: DBSpacing.xs },
  };
}

function DBInputFn(props: DBInputProps, component: any) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const [value, setValue] = useState(String(props.value ?? ""));
  const [focused, setFocused] = useState(false);
  const isInvalid = props.validation === "invalid";
  const isValid = !!(props.validMessage ?? props.validation === "valid") && props.validation === "valid";

  useEffect(() => { setValue(String(props.value ?? "")); }, [props.value]);

  const styles = mkStyles(c);

  return (
    <View style={styles.container} ref={component}>
      {props.label && (
        <DBText style={styles.label}>
          {props.label}{props.required && <DBText style={styles.required}> *</DBText>}
        </DBText>
      )}
      <RNTextInput
        style={[styles.input, focused && styles.focused, isInvalid && styles.invalid, isValid && styles.valid, Boolean(props.disabled) && styles.disabled]}
        value={value}
        onChangeText={(t) => { setValue(t); if (props.onChange) (props.onChange as any)({ target: { value: t } }); }}
        placeholder={String(props.placeholder ?? "")}
        placeholderTextColor={c.textSubtle}
        editable={!Boolean(props.disabled)}
        secureTextEntry={props.type === "password"}
        keyboardType={props.type === "email" ? "email-address" : props.type === "number" || props.type === "tel" ? "numeric" : "default"}
        maxLength={typeof props.maxLength === "number" ? props.maxLength : undefined}
        accessibilityLabel={props.label ?? props.placeholder}
        onFocus={() => { setFocused(true); if (props.onFocus) (props.onFocus as any)(); }}
        onBlur={() => { setFocused(false); if (props.onBlur) (props.onBlur as any)(); }}
      />
      {(props as any).description && <DBText style={styles.description}>{(props as any).description}</DBText>}
      {stringPropVisible(props.message, props.showMessage) && (
        <DBInfotext size="small" semantic="adaptive">{props.message}</DBInfotext>
      )}
      {isValid && <DBInfotext size="small" semantic="successful">{props.validMessage ?? DEFAULT_VALID_MESSAGE}</DBInfotext>}
      {isInvalid && <DBInfotext size="small" semantic="critical">{props.invalidMessage ?? DEFAULT_INVALID_MESSAGE}</DBInfotext>}
    </View>
  );
}

const DBInput = forwardRef<RNTextInput, DBInputProps>(DBInputFn);
export default DBInput;
`,

	/* ---- DBTextarea → TextInput multiline ---- */
	'textarea/textarea.tsx': `import React, { forwardRef, useState, useEffect } from "react";
import { View, TextInput as RNTextInput } from "react-native";
import DBText from "../text/text";
import DBInfotext from "../infotext/infotext";
import { DEFAULT_INVALID_MESSAGE, DEFAULT_VALID_MESSAGE } from "../../shared/constants";
import { stringPropVisible } from "../../utils";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme, DBColors, DBTypography, DBSpacing, DBBorderRadius } from "../../shared/tokens";
import { DBTextareaProps } from "./model";

function mkStyles(c: typeof DBTheme.light) {
  return {
    container: { marginVertical: DBSpacing.xs },
    label: { fontSize: DBTypography.size2XS, color: c.textMuted, marginBottom: DBSpacing.xs },
    required: { color: c.brandPrimary },
    input: { borderWidth: 1, borderColor: c.borderStrong, borderRadius: DBBorderRadius.sm, padding: 10, fontSize: DBTypography.sizeSM, backgroundColor: c.inputBg, color: c.text, minHeight: 80 },
    invalid: { borderColor: DBColors.critical.origin },
    valid: { borderColor: DBColors.successful.origin },
    disabled: { borderColor: c.textDisabled, backgroundColor: c.bgSurface, color: c.textDisabled },
  };
}

function DBTextareaFn(props: DBTextareaProps, component: any) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const [value, setValue] = useState(String(props.value ?? ""));
  const isInvalid = props.validation === "invalid";
  const isValid = !!(props.validMessage ?? props.validation === "valid") && props.validation === "valid";

  useEffect(() => { setValue(String(props.value ?? "")); }, [props.value]);

  const styles = mkStyles(c);

  return (
    <View style={styles.container} ref={component}>
      {props.label && (
        <DBText style={styles.label}>
          {props.label}{props.required && <DBText style={styles.required}> *</DBText>}
        </DBText>
      )}
      <RNTextInput
        style={[styles.input, isInvalid && styles.invalid, isValid && styles.valid, Boolean(props.disabled) && styles.disabled]}
        value={value}
        onChangeText={(t) => { setValue(t); if (props.onChange) (props.onChange as any)({ target: { value: t } }); }}
        placeholder={String(props.placeholder ?? "")}
        placeholderTextColor={c.textSubtle}
        editable={!Boolean(props.disabled)}
        multiline
        numberOfLines={typeof props.rows === "number" ? props.rows : 4}
        textAlignVertical="top"
        maxLength={typeof props.maxLength === "number" ? props.maxLength : undefined}
        accessibilityLabel={props.label ?? props.placeholder}
      />
      {stringPropVisible(props.message, props.showMessage) && (
        <DBInfotext size="small" semantic="adaptive">{props.message}</DBInfotext>
      )}
      {isValid && <DBInfotext size="small" semantic="successful">{props.validMessage ?? DEFAULT_VALID_MESSAGE}</DBInfotext>}
      {isInvalid && <DBInfotext size="small" semantic="critical">{props.invalidMessage ?? DEFAULT_INVALID_MESSAGE}</DBInfotext>}
    </View>
  );
}

const DBTextarea = forwardRef<RNTextInput, DBTextareaProps>(DBTextareaFn);
export default DBTextarea;
`,

	/* ---- DBCustomSelect → Modal multi-select picker ---- */
	'custom-select/model.ts': `export type CustomSelectOptionType = { value?: string; label?: string; disabled?: boolean };
export type DBCustomSelectDefaultProps = {
  label?: string;
  placeholder?: string;
  multiple?: boolean | string;
  disabled?: boolean | string;
  required?: boolean | string;
  /** Selected value(s) — string or comma-separated string or array */
  values?: string | string[];
  options?: CustomSelectOptionType[] | string[];
  message?: string;
  validMessage?: string;
  invalidMessage?: string;
  onOptionSelected?: (values: string[]) => void;
};
import { GlobalProps } from "../../shared/model";
export type DBCustomSelectProps = DBCustomSelectDefaultProps & GlobalProps;
`,

	'custom-select/custom-select.tsx': `import React, { forwardRef, useState } from "react";
import { View, Pressable, Modal, FlatList } from "react-native";
import DBText from "../text/text";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme, DBTypography, DBSpacing, DBBorderRadius } from "../../shared/tokens";
import { DBCustomSelectProps } from "./model";

function mkStyles(c: typeof DBTheme.light) {
  return {
    container: { marginVertical: DBSpacing.xs },
    label: { fontSize: DBTypography.size2XS, color: c.textMuted, marginBottom: DBSpacing.xs },
    trigger: { flexDirection: "row" as const, alignItems: "center" as const, borderWidth: 1, borderColor: c.borderStrong, borderRadius: DBBorderRadius.sm, padding: 10, backgroundColor: c.inputBg },
    triggerDisabled: { borderColor: c.textDisabled, backgroundColor: c.bgSurface },
    triggerText: { flex: 1, fontSize: DBTypography.sizeSM, color: c.text },
    arrow: { fontSize: DBTypography.sizeSM, color: c.textMuted },
    backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.3)", justifyContent: "flex-end" as const },
    sheet: { backgroundColor: c.inputBg, borderTopLeftRadius: DBBorderRadius.lg, borderTopRightRadius: DBBorderRadius.lg, maxHeight: "60%" as any, padding: DBSpacing.sm },
    option: { flexDirection: "row" as const, alignItems: "center" as const, padding: 14, borderBottomWidth: 1, borderBottomColor: c.border },
    optionSelected: { backgroundColor: c.bgElevated },
    optionText: { fontSize: DBTypography.sizeMD, color: c.text, flex: 1 },
    optionTextSelected: { fontWeight: DBTypography.weightBold },
    check: { width: 20, height: 20, borderWidth: 2, borderColor: c.borderStrong, borderRadius: DBBorderRadius.sm, alignItems: "center" as const, justifyContent: "center" as const, marginRight: 10 },
    checkSelected: { backgroundColor: c.brandPrimary, borderColor: c.brandPrimary },
    checkMark: { color: c.bg, fontSize: 12, fontWeight: "bold" as const },
    optionPressed: { backgroundColor: c.bgElevated },
  };
}

function DBCustomSelectFn(props: DBCustomSelectProps, component: any) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(
    Array.isArray(props.values) ? props.values as string[] : props.values ? [props.values as string] : []
  );
  const options: any[] = Array.isArray(props.options) ? props.options : [];
  const display = selected.length ? selected.join(", ") : props.placeholder ?? "Select...";

  function handleSelect(val: string) {
    let next: string[];
    if (props.multiple) {
      next = selected.includes(val) ? selected.filter((v) => v !== val) : [...selected, val];
    } else {
      next = [val];
      setOpen(false);
    }
    setSelected(next);
    if ((props as any).onValueChange) (props as any).onValueChange(next.join(","));
    if (props.onOptionSelected) (props.onOptionSelected as any)(val);
  }

  const styles = mkStyles(c);

  return (
    <View style={styles.container} ref={component}>
      {props.label && <DBText style={styles.label}>{props.label}</DBText>}
      <Pressable
        style={({ pressed }) => [styles.trigger, Boolean(props.disabled) && styles.triggerDisabled, pressed && { opacity: 0.8 }]}
        onPress={() => !Boolean(props.disabled) && setOpen(true)}
        accessibilityRole="combobox"
        accessibilityState={{ expanded: open }}
      >
        <DBText style={styles.triggerText}>{display}</DBText>
        <DBText style={styles.arrow}>{open ? "▴" : "▾"}</DBText>
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            <FlatList
              data={options}
              keyExtractor={(item, i) => {
                const v = typeof item === "object" && item !== null ? String((item as any).value ?? i) : String(item ?? i);
                return v;
              }}
              renderItem={({ item }) => {
                const val = typeof item === "object" && item !== null ? String((item as any).value ?? "") : String(item ?? "");
                const lbl = typeof item === "object" && item !== null ? String((item as any).label ?? val) : val;
                const isSel = selected.includes(val);
                return (
                  <Pressable
                    style={({ pressed }) => [styles.option, isSel && styles.optionSelected, pressed && styles.optionPressed]}
                    onPress={() => handleSelect(val)}
                  >
                    {props.multiple && (
                      <View style={[styles.check, isSel && styles.checkSelected]}>
                        {isSel && <DBText style={styles.checkMark}>✓</DBText>}
                      </View>
                    )}
                    <DBText style={[styles.optionText, isSel && styles.optionTextSelected]}>{lbl}</DBText>
                  </Pressable>
                );
              }}
            />
          </View>
        </Pressable>
      </Modal>
      {props.children}
    </View>
  );
}

const DBCustomSelect = forwardRef<View, DBCustomSelectProps>(DBCustomSelectFn);
export default DBCustomSelect;
`

, 'icon-toggle/model.ts': `import type React from "react";

export interface DBIconToggleOption {
  /** DB icon name — same string as the DBIcon \`icon\` prop (e.g. "light_mode", "dark_mode") */
  icon: string;
  /** Unique value for this option */
  value: string;
  /** Accessibility label (falls back to value) */
  label?: string;
}

export interface DBIconToggleProps {
  /** Toggle options to render */
  options: DBIconToggleOption[];
  /** Currently selected value */
  value: string;
  /** Called when the user selects a different option */
  onChange: (value: string) => void;
}
`

, 'icon-toggle/icon-toggle.tsx': `import React, { useRef, useEffect } from "react";
import { Animated, PanResponder, Pressable, StyleSheet, View } from "react-native";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme } from "../../shared/tokens";
import type { DBIconToggleProps } from "./model";

type MaterialIconsType = React.ComponentType<{
  name: string;
  size: number;
  color?: string;
  accessibilityElementsHidden?: boolean;
}>;

const ITEM_W = 36;
const ITEM_H = 32;
const PAD = 3;

function DBIconToggle({ options, value, onChange }: DBIconToggleProps) {
  const { isDark } = useDBFont();
  const colors = isDark ? DBTheme.dark : DBTheme.light;
  const count = options.length;

  const selectedIdx = Math.max(0, options.findIndex((o) => o.value === value));
  const currentIdx = useRef(selectedIdx);
  const dragStartX = useRef(PAD + selectedIdx * ITEM_W);

  // Always-current refs so PanResponder (created once) never uses stale closures
  const onChangeRef = useRef(onChange);
  const optionsRef  = useRef(options);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { optionsRef.current  = options;  }, [options]);

  const anim = useRef(new Animated.Value(PAD + selectedIdx * ITEM_W)).current;

  useEffect(() => {
    currentIdx.current = selectedIdx;
  }, [selectedIdx]);

  useEffect(() => {
    Animated.spring(anim, {
      toValue: PAD + selectedIdx * ITEM_W,
      useNativeDriver: false,
      tension: 280,
      friction: 24,
    }).start();
  }, [selectedIdx]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      // Capture horizontal drags even if a child Pressable already holds the touch
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 3,
      onMoveShouldSetPanResponderCapture: (_, g) => Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 3,
      onPanResponderGrant: (_, g) => {
        // g.dx may already be non-zero (captured mid-move), compensate so pill starts at rest position
        dragStartX.current = PAD + currentIdx.current * ITEM_W - g.dx;
        anim.stopAnimation();
      },
      onPanResponderMove: (_, g) => {
        const cnt = optionsRef.current.length;
        const newX = Math.max(PAD, Math.min(PAD + (cnt - 1) * ITEM_W, dragStartX.current + g.dx));
        anim.setValue(newX);
      },
      onPanResponderRelease: (_, g) => {
        const cnt = optionsRef.current.length;
        const rawX = dragStartX.current + g.dx - PAD;
        const nearestIdx = Math.max(0, Math.min(cnt - 1, Math.round(rawX / ITEM_W)));
        Animated.spring(anim, {
          toValue: PAD + nearestIdx * ITEM_W,
          useNativeDriver: false,
          tension: 280,
          friction: 24,
        }).start();
        if (nearestIdx !== currentIdx.current) {
          onChangeRef.current(optionsRef.current[nearestIdx].value);
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(anim, {
          toValue: PAD + currentIdx.current * ITEM_W,
          useNativeDriver: false,
          tension: 280,
          friction: 24,
        }).start();
      },
    })
  ).current;

  const totalW = count * ITEM_W + PAD * 2;
  const pillH = ITEM_H + PAD * 2;

  // Lazy require — same pattern as DBIcon to avoid PlatformConstants crash on startup
  const _mi = require("@expo/vector-icons/MaterialIcons");
  const MaterialIcons: MaterialIconsType = _mi.default ?? _mi;

  return (
    <View
      style={[styles.track, {
        width: totalW,
        height: pillH,
        borderRadius: pillH / 2,
        backgroundColor: colors.bgSurface,
      }]}
      {...panResponder.panHandlers}
      accessibilityRole="radiogroup"
    >
      {/* Sliding pill */}
      <Animated.View
        style={[styles.pill, {
          width: ITEM_W,
          height: ITEM_H,
          borderRadius: ITEM_H / 2,
          backgroundColor: colors.bg,
          top: PAD,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: isDark ? 0.3 : 0.12,
          shadowRadius: 3,
          elevation: 3,
          transform: [{ translateX: anim }],
        }]}
      />

      {/* Icon options (above pill) */}
      <View style={[styles.optionRow, { paddingHorizontal: PAD, paddingVertical: PAD }]}>
        {options.map((opt, i) => {
          const isActive = i === selectedIdx;
          const iconName = (opt.icon as string)?.replace(/_/g, "-");
          return (
            <Pressable
              key={opt.value}
              style={[styles.option, { width: ITEM_W, height: ITEM_H }]}
              onPress={() => { if (!isActive) onChange(opt.value); }}
              accessibilityLabel={opt.label ?? opt.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: isActive }}
            >
              <MaterialIcons
                name={iconName}
                size={18}
                color={isActive ? colors.brandText : colors.textMuted}
                accessibilityElementsHidden
              />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    position: "relative",
    overflow: "hidden",
  },
  pill: {
    position: "absolute",
    left: 0,
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    zIndex: 1,
  },
  option: {
    alignItems: "center",
    justifyContent: "center",
  },
});

export default DBIconToggle;
`
};

// ---------------------------------------------------------------------------
// Additional overrides for auto-generated components needing cleanup
// ---------------------------------------------------------------------------

const AUTO_COMPONENT_OVERRIDES: Record<string, string> = {
  'badge/badge.tsx': `import React from "react";
import { View, StyleSheet } from "react-native";
import DBText from "../text/text";
import { useDBFont } from "../../providers/font-provider";
import { DBColorPalette, DBColorPaletteDark, DBTypography, DBSpacing, DBBorderRadius } from "../../shared/tokens";
import type { DBBadgeProps } from "./model";

type SemanticKey = keyof typeof DBColorPalette;

function DBBadge(props: DBBadgeProps) {
  const { isDark } = useDBFont();
  const semantic: SemanticKey = (props.semantic as SemanticKey) ?? "adaptive";
  const isStrong = props.emphasis === "strong";
  const size = props.size ?? "small";

  const palette = (isDark ? DBColorPaletteDark : DBColorPalette)[semantic as keyof typeof DBColorPaletteDark] ?? (isDark ? DBColorPaletteDark : DBColorPalette).neutral;
  const bgColor     = isStrong ? palette.strongBg   : palette.weakBg;
  const textColor   = isStrong ? palette.strongText : palette.weakText;
  const borderColor = palette.border;
  const fontSize    = size === "medium" ? DBTypography.size2XS : DBTypography.size3XS;
  const px          = size === "medium" ? DBSpacing.sm : DBSpacing.xs;

  return (
    <View style={[styles.base, { backgroundColor: bgColor, paddingHorizontal: px, borderColor }]}>
      <DBText style={[styles.text, { color: textColor, fontSize }]}>
        {props.text ?? props.children}
      </DBText>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: DBBorderRadius.full,
    borderWidth: 1,
    paddingVertical: 2,
    alignSelf: "flex-start",
    justifyContent: "center",
    alignItems: "center",
  },
  text: {
    fontWeight: DBTypography.weightBold,
  },
});

export default DBBadge;
`,

  'brand/brand.tsx': `import React from "react";
import { View, StyleSheet } from "react-native";
import { SvgXml } from "react-native-svg";
import DBText from "../text/text";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme } from "../../shared/tokens";
import type { DBBrandProps } from "./model";

// Official DB logo SVG — red outlined rectangle with DB letterforms
const DB_LOGO_SVG = \`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 28">
  <rect x="2" y="2" width="36" height="24" fill="transparent"/>
  <path d="M27.2 7.53h-1.43v4.54h1.83c1.53.03 2.47-1.04 2.47-2.27 0-1.63-.96-2.32-2.87-2.27zm.6 7.8h-2.04v4.84h1.84c.7.01 3.07 0 3.07-2.37 0-1.01-.62-2.5-2.87-2.47zm-17.1-7.7h-.83v12.54h1.53c2.58.06 3.77-2.05 3.77-5.97 0-3.6-.41-6.74-4.47-6.57zm18.4-2.76c5.13.02 5.23 4.03 5.23 4.43a4.33 4.33 0 01-3.15 4.13v.14c3.26.79 3.75 3.14 3.75 4.43 0 4.76-4.68 5.02-6.71 5.03h-6.68V4.87h7.56zm-16.9 0c4.7.02 7.23 3.01 7.23 9.03 0 5.29-1.68 9.1-7.23 9.13H5.54V4.87h6.66zm23.7-1.94H4c-.63 0-1.04.5-1.06 1.05l-.01.12v19.7c0 .57.35 1.22.95 1.26l.12.01h31.9c.63 0 1.13-.6 1.16-1.14l.01-.13V4.1a1.2 1.2 0 00-1.17-1.17zm0-2.86c2.1 0 3.97 1.56 4.03 3.63v20.2a4 4 0 01-3.83 4.03H4A3.91 3.91 0 01.07 24.1V3.9A3.8 3.8 0 013.8.07h32.1z" fill="#ec0016"/>
</svg>\`;

function DBBrand(props: DBBrandProps) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;

  return (
    <View style={styles.container}>
      {!props.hideLogo && (
        <SvgXml xml={DB_LOGO_SVG} width={40} height={28} />
      )}
      {(props.text || props.children) && (
        <>
          {!props.hideLogo && (
            <View style={[styles.separator, { backgroundColor: c.border }]} />
          )}
          {props.text ? (
            <DBText weight="bold" style={[styles.productName, { color: c.text }]}>
              {props.text}
            </DBText>
          ) : props.children}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: "row", alignItems: "center", gap: 10 },
  separator: { width: 1, height: 26, flexShrink: 0 },
  productName: { fontSize: 16, fontWeight: "600", letterSpacing: -0.2 },
});

export default DBBrand;
`,

  'card/card.tsx': `import React, { useContext } from "react";
import { View, Pressable } from "react-native";
import DBText from "../text/text";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme, DBBorderRadius, DBSpacing } from "../../shared/tokens";
import { DBSectionContext } from "../section/section";
import type { DBCardProps } from "./model";

function DBCard(props: DBCardProps) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const level = String(props.elevationLevel ?? "1") as "1" | "2" | "3";
  const sectionCtx = useContext(DBSectionContext);

  const elevationMap = {
    "1": {
      bg: c.bg,
      borderWidth: 1,    borderColor: c.border,
      shadowOpacity: 0,  shadowRadius: 0,  shadowOffset: { width: 0, height: 0 }, elevation: 0,
    },
    "2": {
      bg: c.bg,
      borderWidth: 0,    borderColor: "transparent" as const,
      shadowOpacity: isDark ? 0.03 : 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: isDark ? 3 : 6,
    },
    "3": {
      bg: c.bg,
      borderWidth: 0,    borderColor: "transparent" as const,
      shadowOpacity: isDark ? 0.06 : 0.14, shadowRadius: 28, shadowOffset: { width: 0, height: 12 }, elevation: isDark ? 6 : 12,
    },
  };
  const e = elevationMap[level] ?? elevationMap["1"];

  const sizeStyle = sectionCtx.isFull
    ? { flex: 1 }
    : sectionCtx.cardWidth != null
      ? { width: sectionCtx.cardWidth }
      : {};

  const cardStyle = {
    backgroundColor: e.bg,
    borderRadius: DBBorderRadius.md,
    borderWidth: e.borderWidth,
    borderColor: e.borderColor,
    padding: DBSpacing.md,
    marginVertical: DBSpacing.xs,
    shadowColor: c.shadowColor,
    shadowOffset: e.shadowOffset,
    shadowOpacity: e.shadowOpacity,
    shadowRadius: e.shadowRadius,
    elevation: e.elevation,
    ...sizeStyle,
  };

  if (props.onClick || (props as any).behavior === "interactive") {
    return (
      <Pressable
        style={({ pressed }) => [cardStyle, (props as any).style, pressed && { opacity: 0.92 }]}
        onPress={props.onClick as any}
        accessibilityRole="button"
      >
        {props.children}
      </Pressable>
    );
  }
  return <View style={[cardStyle, (props as any).style]}>{props.children}</View>;
}

export default DBCard;
`,

  'divider/divider.tsx': `import React from "react";
import { View, StyleSheet } from "react-native";
import DBText from "../text/text";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme } from "../../shared/tokens";
import type { DBDividerProps } from "./model";

function DBDivider(props: DBDividerProps) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const isVertical = props.variant === "vertical";
  return (
    <View
      style={[
        { backgroundColor: c.border },
        isVertical ? styles.vertical : styles.horizontal,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  horizontal: { height: 1, alignSelf: "stretch", marginVertical: 8 },
  vertical: { width: 1, alignSelf: "stretch", marginHorizontal: 8 },
});

export default DBDivider;
`,

  'infotext/infotext.tsx': `import React from "react";
import { View, StyleSheet } from "react-native";
import DBText from "../text/text";
import { useDBFont } from "../../providers/font-provider";
import { DBColorPalette, DBColorPaletteDark, DBTypography, DBSpacing } from "../../shared/tokens";
import type { DBInfotextProps } from "./model";

type SemanticKey = keyof typeof DBColorPalette;

function DBInfotext(props: DBInfotextProps) {
  const { isDark } = useDBFont();
  const sem: SemanticKey = (props.semantic as SemanticKey) ?? "adaptive";
  const palette = (isDark ? DBColorPaletteDark : DBColorPalette)[sem as keyof typeof DBColorPaletteDark]
    ?? (isDark ? DBColorPaletteDark : DBColorPalette).neutral;
  return (
    <View style={styles.container}>
      <DBText style={[styles.text, { color: palette.weakText }]}>{props.text ?? props.children}</DBText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingVertical: DBSpacing.xs },
  text: { fontSize: DBTypography.sizeXS },
});

export default DBInfotext;
`,

  'notification/notification.tsx': `import React, { useState } from "react";
import { View, Pressable, StyleSheet } from "react-native";
import DBText from "../text/text";
import { stringPropVisible } from "../../utils";
import { useDBFont } from "../../providers/font-provider";
import { DBColorPalette, DBColorPaletteDark, DBTheme, DBTypography, DBSpacing, DBBorderRadius } from "../../shared/tokens";
import type { DBNotificationProps } from "./model";
import { DEFAULT_CLOSE_BUTTON } from "../../shared/constants";

type SemanticKey = keyof typeof DBColorPalette;

function DBNotification(props: DBNotificationProps) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  const sem: SemanticKey = (props.semantic as SemanticKey) ?? "adaptive";
  const palette = (isDark ? DBColorPaletteDark : DBColorPalette)[sem as keyof typeof DBColorPaletteDark]
    ?? (isDark ? DBColorPaletteDark : DBColorPalette).neutral;

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: c.bg,
          borderLeftColor: palette.border,
          shadowColor: c.shadowColor,
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: isDark ? 0.02 : 0.05,
          shadowRadius: 3,
          elevation: 2,
        },
      ]}
      accessibilityRole="alert"
    >
      {props.image ? <View style={styles.imageSlot}>{props.image as any}</View> : null}
      {stringPropVisible(props.headline, props.showHeadline) ? (
        <DBText style={[styles.headline, { color: c.text }]}>{props.headline}</DBText>
      ) : null}
      <DBText style={[styles.body, { color: c.text }]}>{props.text ?? props.children}</DBText>
      {stringPropVisible(props.timestamp, props.showTimestamp) ? (
        <DBText style={[styles.timestamp, { color: c.textSubtle }]}>{props.timestamp}</DBText>
      ) : null}
      {props.link ? <View>{props.link as any}</View> : null}
      {Boolean(props.closeable) ? (
        <Pressable
          style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.7 }]}
          onPress={() => { setVisible(false); if (props.onClose) (props.onClose as any)(); }}
          accessibilityLabel={props.closeButtonText ?? DEFAULT_CLOSE_BUTTON}
          accessibilityRole="button"
        >
          <DBText style={[styles.closeBtnText, { color: c.textMuted }]}>✕</DBText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: DBBorderRadius.md,
    borderLeftWidth: 4,
    padding: DBSpacing.md,
    marginVertical: DBSpacing.xs + 2,
  },
  imageSlot: { marginBottom: DBSpacing.sm },
  headline: { fontSize: DBTypography.sizeMD, fontWeight: DBTypography.weightBold, marginBottom: DBSpacing.xs },
  body: { fontSize: DBTypography.sizeSM },
  timestamp: { fontSize: DBTypography.size3XS, marginTop: DBSpacing.xs },
  closeBtn: { position: "absolute", top: DBSpacing.sm, right: DBSpacing.sm, padding: DBSpacing.xs },
  closeBtnText: { fontSize: DBTypography.sizeMD },
});

export default DBNotification;
`,

  'section/section.tsx': `import React, { createContext } from "react";
import { View, useWindowDimensions } from "react-native";
import { useDBFont } from "../../providers/font-provider";
import type { DBSectionProps } from "./model";

export const DBSectionContext = createContext<{ cardWidth?: number; isFull: boolean }>({ isFull: false });

const SPACING_PAD: Record<string, number> = {
  none: 0, small: 16, medium: 32, large: 48,
};

const DENSITY_GAP: Record<string, number> = {
  functional: 8, regular: 16, expressive: 24,
};

// fraction of screenWidth for the section itself
const SECTION_SCALE: Record<string, number> = {
  small: 0.45, medium: 0.65, large: 0.85,
};

function DBSection(props: DBSectionProps) {
  const { isDark } = useDBFont();
  const { width: screenW } = useWindowDimensions();
  const sectionBg = isDark ? "#062736" : "#ebf5fe";
  const spacing: string = (props as any).spacing ?? "none";
  const density: string = (props as any).density ?? "regular";
  const widthKey: string = (props as any).width ?? "full";
  const isFull = widthKey === "full";

  const pad = SPACING_PAD[spacing] ?? 0;
  const gap = DENSITY_GAP[density] ?? 16;

  // Section width
  const sectionW: number | "100%" = isFull
    ? "100%"
    : Math.round(screenW * (SECTION_SCALE[widthKey] ?? 0.65));

  // Always exactly 2 cards per row
  const innerW = typeof sectionW === "number" ? sectionW : screenW;
  const cardWidth = Math.floor((innerW - 2 * pad - gap) / 2);

  return (
    <DBSectionContext.Provider value={{ cardWidth, isFull }}>
      <View
        style={[
          { padding: pad, backgroundColor: sectionBg, width: sectionW },
          (props as any).style,
        ]}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap }}>
          {props.children}
        </View>
      </View>
    </DBSectionContext.Provider>
  );
}

export default DBSection;
`,

  'stack/stack.tsx': `import React from "react";
import { View } from "react-native";
import { DBSpacing } from "../../shared/tokens";
import type { DBStackProps } from "./model";

const GAP_MAP: Record<string, number> = {
  none:   0,
  xs:     DBSpacing.xs,
  sm:     DBSpacing.sm,
  md:     DBSpacing.md,
  lg:     DBSpacing.lg,
  xl:     DBSpacing.xl,
};

const ALIGN_MAP: Record<string, "flex-start" | "flex-end" | "center" | "stretch"> = {
  start:   "flex-start",
  end:     "flex-end",
  center:  "center",
  stretch: "stretch",
};

const JUSTIFY_MAP: Record<string, "flex-start" | "flex-end" | "center" | "space-between"> = {
  start:          "flex-start",
  end:            "flex-end",
  center:         "center",
  "space-between": "space-between",
};

function DBStack(props: DBStackProps) {
  const isRow = props.direction === "row";
  const gap = GAP_MAP[(props as any).gap ?? "md"] ?? DBSpacing.md;
  const alignItems = ALIGN_MAP[props.alignment ?? (isRow ? "center" : "stretch")] ?? (isRow ? "center" : "stretch");
  const justifyContent = JUSTIFY_MAP[props.justifyContent ?? "start"] ?? "flex-start";
  const flexWrap = props.wrap ? "wrap" : "nowrap";

  return (
    <View
      style={{
        flexDirection: isRow ? "row" : "column",
        flexWrap,
        gap,
        alignItems,
        justifyContent,
      }}
    >
      {props.children}
    </View>
  );
}

export default DBStack;
`,

  'tag/tag.tsx': `import React from "react";
import { View, Pressable, StyleSheet } from "react-native";
import DBText from "../text/text";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme, DBSpacing, DBBorderRadius } from "../../shared/tokens";
import { DEFAULT_REMOVE } from "../../shared/constants";
import type { DBTagProps } from "./model";

function DBTag(props: DBTagProps) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const removeLabel = props.removeButton ?? DEFAULT_REMOVE;
  return (
    <View style={[styles.tag, { backgroundColor: c.bgElevated }]}>
      <DBText style={[styles.text, { color: c.text }]}>{props.content ?? props.text ?? props.children}</DBText>
      {props.behavior === "removable" ? (
        <Pressable
          style={({ pressed }) => [styles.removeBtn, pressed && { opacity: 0.7 }]}
          onPress={props.onRemove as any}
          accessibilityLabel={removeLabel}
          accessibilityRole="button"
        >
          <DBText style={[styles.removeBtnText, { color: c.textMuted }]}>✕</DBText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: DBBorderRadius.full,
    paddingHorizontal: DBSpacing.sm + 2,
    paddingVertical: DBSpacing.xs,
    marginRight: DBSpacing.xs,
    marginBottom: DBSpacing.xs,
    alignSelf: "flex-start",
  },
  text: { fontSize: 13 },
  removeBtn: { marginLeft: 6, padding: 2 },
  removeBtnText: { fontSize: 12 },
});

export default DBTag;
`,

  'tab-list/tab-list.tsx': `import React, { useState } from "react";
import { View, ScrollView, StyleSheet } from "react-native";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme } from "../../shared/tokens";
import type { DBTabListProps } from "./model";

function DBTabList(props: DBTabListProps) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const isFull = (props as any).width === "full";
  const alignment: "start" | "center" = (props as any).alignment ?? "start";
  const [listWidth, setListWidth] = useState(0);

  const children = React.Children.map(props.children, (child) =>
    React.isValidElement(child)
      ? React.cloneElement(child as React.ReactElement<any>, { _full: isFull, _alignment: alignment })
      : child
  );

  return (
    <View
      style={[styles.container, { borderBottomColor: c.border }]}
      onLayout={(e) => setListWidth(e.nativeEvent.layout.width)}
    >
      {isFull ? (
        <View style={styles.fullRow}>{children}</View>
      ) : (
        <ScrollView
          horizontal
          scrollEnabled
          nestedScrollEnabled
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.content}
          style={listWidth > 0 ? { width: listWidth } : styles.scrollFallback}
        >
          {children}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { borderBottomWidth: StyleSheet.hairlineWidth, alignSelf: "stretch" },
  scrollFallback: { flexShrink: 1 },
  content: { flexDirection: "row", alignItems: "center" },
  fullRow: { flexDirection: "row" },
});

export default DBTabList;
`,

  'tab-item/tab-item.tsx': `import React from "react";
import { Pressable, StyleSheet } from "react-native";
import DBText from "../text/text";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme, DBTypography } from "../../shared/tokens";
import type { DBTabItemProps } from "./model";

function DBTabItem(props: DBTabItemProps) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const selected = Boolean(props.active);
  const isFull = Boolean((props as any)._full);
  const alignment: "start" | "center" = (props as any)._alignment ?? "start";

  return (
    <Pressable
      style={({ pressed }) => [
        styles.item,
        isFull && styles.itemFull,
        selected ? { borderBottomColor: c.brandPrimary } : { borderBottomColor: "transparent" },
        pressed && { opacity: 0.75 },
      ]}
      onPress={() => {
        const handler = (props.onChange ?? (props as any).onSelect) as any;
        handler?.();
      }}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
    >
      <DBText style={[
        styles.label,
        { color: selected ? c.text : c.textMuted },
        selected && styles.labelSelected,
        alignment === "center" && styles.labelCenter,
      ]}>
        {props.label ?? props.children}
      </DBText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  item: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 2,
    marginRight: 4,
  },
  itemFull: { flex: 1, marginRight: 0 },
  label: { fontSize: DBTypography.sizeSM },
  labelSelected: { fontWeight: "bold" },
  labelCenter: { textAlign: "center" },
});

export default DBTabItem;
`,

  'tab-panel/tab-panel.tsx': `import React from "react";
import { View, StyleSheet } from "react-native";
import DBText from "../text/text";
import type { DBTabPanelProps } from "./model";

function DBTabPanel(props: DBTabPanelProps) {
  return (
    <View style={styles.panel} accessibilityRole="summary">
      {props.content ?? props.children}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { padding: 16 },
});

export default DBTabPanel;
`,

  'custom-select-dropdown/custom-select-dropdown.tsx': `import React from "react";
import { View, StyleSheet } from "react-native";
import DBText from "../text/text";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme, DBBorderRadius } from "../../shared/tokens";
import type { DBCustomSelectDropdownProps } from "./model";

function DBCustomSelectDropdown(props: DBCustomSelectDropdownProps) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  return (
    <View
      style={[
        styles.dropdown,
        {
          backgroundColor: c.bg,
          borderColor: c.border,
          shadowColor: c.shadowColor,
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.15,
          shadowRadius: 4,
          elevation: 5,
        },
      ]}
    >
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create({
  dropdown: {
    position: "absolute",
    top: "100%" as any,
    left: 0,
    right: 0,
    borderRadius: DBBorderRadius.sm,
    borderWidth: 1,
    zIndex: 1000,
  },
});

export default DBCustomSelectDropdown;
`,

  'custom-select-form-field/custom-select-form-field.tsx': `import React from "react";
import { View, StyleSheet } from "react-native";
import DBText from "../text/text";
import type { DBCustomSelectFormFieldProps } from "./model";

function DBCustomSelectFormField(props: DBCustomSelectFormFieldProps) {
  return <View style={styles.formField}>{props.children}</View>;
}

const styles = StyleSheet.create({
  formField: { flexDirection: "row", alignItems: "center", paddingVertical: 6 },
});

export default DBCustomSelectFormField;
`,

  'custom-select-list/custom-select-list.tsx': `import React from "react";
import { ScrollView, StyleSheet } from "react-native";
import DBText from "../text/text";
import type { DBCustomSelectListProps } from "./model";

function DBCustomSelectList(props: DBCustomSelectListProps) {
  return (
    <ScrollView style={styles.list} nestedScrollEnabled>
      {props.children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { maxHeight: 240 },
});

export default DBCustomSelectList;
`,

  'custom-select-list-item/custom-select-list-item.tsx': `import React from "react";
import { View, Pressable, StyleSheet } from "react-native";
import DBText from "../text/text";
import { useDBFont } from "../../providers/font-provider";
import { DBTheme, DBTypography, DBBorderRadius, DBSpacing } from "../../shared/tokens";
import { getBoolean } from "../../utils";
import type { DBCustomSelectListItemProps } from "./model";

function DBCustomSelectListItem(props: DBCustomSelectListItemProps) {
  const { isDark } = useDBFont();
  const c = (isDark ? DBTheme.dark : DBTheme.light) as typeof DBTheme.light;
  const selected = getBoolean(props.checked);
  const disabled = getBoolean(props.disabled);
  const value = props.value ?? props.label ?? "";
  return (
    <Pressable
      style={({ pressed }) => [
        styles.item,
        { borderBottomColor: c.border },
        selected && { backgroundColor: c.bgElevated },
        disabled && styles.disabled,
        pressed && !disabled && { backgroundColor: c.bgElevated },
      ]}
      onPress={!disabled ? () => { if (props.onChange) (props.onChange as any)({ target: { value, checked: !selected } }); } : undefined}
      disabled={disabled}
      accessibilityRole="menuitem"
      accessibilityState={{ selected, disabled }}
    >
      {props.type === "checkbox" ? (
        <View style={[styles.check, { borderColor: c.borderStrong }, selected && { backgroundColor: c.brandPrimary, borderColor: c.brandPrimary }]}>
          {selected ? <DBText style={[styles.checkMark, { color: c.bg }]}>✓</DBText> : null}
        </View>
      ) : null}
      <DBText style={[styles.label, { color: c.text }, disabled && { color: c.textDisabled }]}>
        {props.label ?? props.children}
      </DBText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  item: { flexDirection: "row", alignItems: "center", padding: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  disabled: { opacity: 0.4 },
  check: { width: 18, height: 18, borderWidth: 2, borderRadius: DBBorderRadius.sm, alignItems: "center", justifyContent: "center", marginRight: 10 },
  checkMark: { fontSize: 11, fontWeight: "bold" },
  label: { fontSize: DBTypography.sizeSM, flex: 1 },
});

export default DBCustomSelectListItem;
`,
};

// Merge both override maps (COMPONENT_OVERRIDES takes precedence for manually overridden components)
const ALL_COMPONENT_OVERRIDES: Record<string, string> = {
  ...AUTO_COMPONENT_OVERRIDES,
  ...COMPONENT_OVERRIDES,
};

// ---------------------------------------------------------------------------
// Transform helpers
// ---------------------------------------------------------------------------

function transformFile(content: string): string {
	let result = content;
	for (const pattern of REMOVE_PATTERNS) result = result.replace(pattern, '');
	for (const [from, to] of REPLACEMENTS) {
		if (typeof from === 'string') {
			result = result.split(from).join(to as string);
		} else {
			result = result.replace(from, to as string);
		}
	}
	result = result.replace(/\n{3,}/g, '\n\n');
	return result;
}

function ensureDir(dir: string) {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function copyAndTransformDir(srcDir: string, destDir: string) {
	if (!existsSync(srcDir)) return;
	ensureDir(destDir);
	for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
		const srcPath = join(srcDir, entry.name);
		const destPath = join(destDir, entry.name);
		if (entry.isDirectory()) {
			copyAndTransformDir(srcPath, destPath);
		} else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
			const content = readFileSync(srcPath, 'utf-8');
			writeFileSync(destPath, transformFile(content), 'utf-8');
		}
	}
}

// ---------------------------------------------------------------------------
// Example-file cleanup + spec purge
// ---------------------------------------------------------------------------

function cleanExamplesAndPurgeSpecs(rootDir: string) {
	let examplesCleaned = 0;
	let specsPurged = 0;

	function walk(dir: string) {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.spec.tsx') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) {
				unlinkSync(fullPath);
				specsPurged++;
			} else if (entry.name.endsWith('.example.tsx') || entry.name.endsWith('.example.ts') ||
			entry.name.endsWith('.showcase.tsx') || entry.name.endsWith('.showcase.ts')) {
				let src = readFileSync(fullPath, 'utf-8');
				// Remove className prop (no meaning in RN)
				src = src.replace(/\s+className="[^"]*"/g, '');
				src = src.replace(/\s+className=\{[^}]*\}/g, '');
				// Convert WAI-ARIA role= to accessibilityRole= (only plain string values)
				src = src.replace(/\brole="([^"]+)"/g, 'accessibilityRole="$1"');
				// Remove HTMLInputElement / HTMLElement type casts in examples
				src = src.replace(/ as HTML\w+Element/g, '');
				src = src.replace(/\(event\.target as HTML\w+Element\)\./g, '(event as any).');
				writeFileSync(fullPath, src, 'utf-8');
				examplesCleaned++;
			}
		}
	}

	walk(rootDir);
	console.log(`  [examples] cleaned ${examplesCleaned} example files, purged ${specsPurged} spec files`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default function reactNative(_tmp?: boolean) {
	try {
		console.log(`[RN] src:  ${TMP_SRC}`);
		console.log(`[RN] dest: ${RN_DEST}`);

		// -----------------------------------------------------------------------
		// Step 0: Build foundations + component CSS for StyleSheet conversion
		// -----------------------------------------------------------------------
		buildFoundationsCSS();
		buildComponentsCSS();

		// Build CSS variable map once (used for all components)
		console.log('  [css→rn] building CSS variable map...');
		const cssVarMap = buildCSSVarMap();
		console.log(`  [css→rn] ${Object.keys(cssVarMap).length} CSS variables loaded`);

		copyAndTransformDir(TMP_SRC, RN_DEST);

		// Write design tokens file
		const sharedDir = join(RN_DEST, 'shared');
		ensureDir(sharedDir);
		writeFileSync(join(sharedDir, 'tokens.ts'), buildTokensFile(cssVarMap), 'utf-8');
		console.log('  [tokens] shared/tokens.ts');

		// Write font provider
		const providersDir = join(RN_DEST, 'providers');
		ensureDir(providersDir);
		const FONT_PROVIDER = `import React, { createContext, useContext, useEffect, useState } from "react";
import { Appearance } from "react-native";
import { useFonts } from "expo-font";
import { DBFontFamily } from "../shared/tokens";

export interface DBFontSources {
  /** Require path to the regular weight font file. */
  regular: any;
  /** Require path to the medium weight font file. */
  medium: any;
  /** Require path to the bold weight font file. */
  bold: any;
  /** Require path to the semibold weight font file. Falls back to medium. */
  semibold?: any;
}

interface DBFontContextValue {
  /** True when the active color scheme is dark. */
  isDark: boolean;
  /** Resolved font family names — always use these in component styles. */
  fontFamily: {
    regular: string;
    medium: string;
    semibold: string;
    bold: string;
  };
}

const DEFAULT_FONT_FAMILY = {
  regular:  DBFontFamily.regular,
  medium:   DBFontFamily.medium,
  semibold: DBFontFamily.semibold,
  bold:     DBFontFamily.bold,
};

const DBFontContext = createContext<DBFontContextValue>({
  isDark: false,
  fontFamily: DEFAULT_FONT_FAMILY,
});

/**
 * Wrap your app root with DBFontProvider. It loads fonts internally and
 * exposes them to all DB UX components via context — no manual useFonts needed.
 *
 * @example
 * <DBFontProvider
 *   fonts={{
 *     regular:  require('./assets/fonts/MyFont-Regular.ttf'),
 *     medium:   require('./assets/fonts/MyFont-Medium.ttf'),
 *     bold:     require('./assets/fonts/MyFont-Bold.ttf'),
 *   }}
 *   colorScheme="auto"
 * >
 *   <App />
 * </DBFontProvider>
 */
export function DBFontProvider({
  children,
  fonts,
  colorScheme = 'auto',
}: {
  children: React.ReactNode;
  /** Font source files to load. If omitted, the system font is used. */
  fonts?: DBFontSources;
  /** 'light' | 'dark' | 'auto' (follows system preference). Default: 'auto'. */
  colorScheme?: 'light' | 'dark' | 'auto';
}) {
  const fontMap = fonts ? {
    [DBFontFamily.regular]:  fonts.regular,
    [DBFontFamily.medium]:   fonts.medium,
    [DBFontFamily.semibold]: fonts.semibold ?? fonts.medium,
    [DBFontFamily.bold]:     fonts.bold,
  } : {};

  const [fontsLoaded] = useFonts(fontMap);

  const [systemScheme, setSystemScheme] = useState<'light' | 'dark'>(
    Appearance.getColorScheme() === 'dark' ? 'dark' : 'light'
  );

  useEffect(() => {
    const sub = Appearance.addChangeListener(({ colorScheme: s }) => {
      setSystemScheme(s === 'dark' ? 'dark' : 'light');
    });
    return () => sub.remove();
  }, []);

  const resolved = colorScheme === 'auto' ? systemScheme : colorScheme;
  const isDark = resolved === 'dark';

  // Wait for fonts if custom fonts were provided
  if (fonts && !fontsLoaded) return null;

  return (
    <DBFontContext.Provider value={{ isDark, fontFamily: DEFAULT_FONT_FAMILY }}>
      {children}
    </DBFontContext.Provider>
  );
}

export function useDBFont(): DBFontContextValue {
  return useContext(DBFontContext);
}
`;
		writeFileSync(join(providersDir, 'font-provider.tsx'), FONT_PROVIDER, 'utf-8');
		console.log('  [provider] providers/font-provider.tsx');

		// Copy Open Sans font files from foundations into the package assets folder
		const fontSrcDir = join(REPO_ROOT, 'packages/foundations/assets/fonts');
		const fontDestDir = join(REPO_ROOT, 'output/react-native/assets/fonts');
		ensureDir(fontDestDir);
		for (const name of ['DBNeoScreenSans-Regular', 'DBNeoScreenSans-Medium', 'DBNeoScreenSans-SemiBold', 'DBNeoScreenSans-Bold']) {
			const src  = join(fontSrcDir, `${name}.ttf`);
			const dest = join(fontDestDir, `${name}.ttf`);
			if (existsSync(src)) {
				copyFileSync(src, dest);
				console.log(`  [fonts] assets/fonts/${name}.ttf`);
			}
		}

		// Overwrite shared utilities
		const utilsDir = join(RN_DEST, 'utils');
		ensureDir(utilsDir);
		writeFileSync(join(utilsDir, 'index.ts'), RN_UTILS, 'utf-8');
		writeFileSync(join(utilsDir, 'form-components.ts'), RN_FORM_COMPONENTS_UTILS, 'utf-8');

		// Patch shared model
		const modelPath = join(RN_DEST, 'shared', 'model.ts');
		if (existsSync(modelPath)) {
			let m = readFileSync(modelPath, 'utf-8');
			m = m.replace(`import * as React from "react";\n`, '');
			// Replace @db-ux/core-foundations import with an inline stub
			// (foundations may not be built in the consumer's environment)
			m = m.replace(
				/import \{ IconTypes \} from '@db-ux\/core-foundations';\n?/g,
				'/** Stub: icon name — use any string matching the DB icon set */\nexport type IconTypes = string;\n'
			);
			m = m
				.replace(/export type ClickEvent<T> = [^;]+;/, '')
				.replace(/export type ChangeEvent<T> = [^;]+;/, '')
				.replace(/export type InputEvent<T> = [^;]+;/, '')
				.replace(/export type InteractionEvent<T> = [^;]+;/, '')
				.replace(/export type GeneralEvent<T> = [^;]+;/, '')
				.replace(/export type GeneralKeyboardEvent<T> = [^;]+;/, '');
			// Patch DOM-only types that aren't in lib: ["es2022"]
			m = m.replace(/_observer\?: IntersectionObserver;/g, '_observer?: unknown;');
			m = m.replace(/: ResizeObserver\b/g, ': unknown');
			m += RN_SHARED_MODEL_PATCH;
			writeFileSync(modelPath, m, 'utf-8');
		}

		// Stub out web-only utility files that leaked from the React output
		const webOnlyStubs: Record<string, string> = {
			'document-click-listener.ts': `/** Stub: no global click listener in React Native */
import { uuid } from './index';
export class DocumentClickListener {
  static addCallback(_id: string, _cb: (e: any) => void): void {}
  static removeCallback(_id: string): void {}
  static getInstance(): DocumentClickListener { return new DocumentClickListener(); }
}
`,
			'document-scroll-listener.ts': `/** Stub: no global scroll listener in React Native */
import { uuid } from './index';
export class DocumentScrollListener {
  static addCallback(_id: string, _cb: (e: any) => void): void {}
  static removeCallback(_id: string): void {}
  static getInstance(): DocumentScrollListener { return new DocumentScrollListener(); }
}
`,
			'floating-components.ts': `/** Stub: no floating/anchor positioning in React Native */
export const handleDataOutside = (..._args: unknown[]): void => {};
export const getFloatingPosition = (..._args: unknown[]): void => {};
`,
			'navigation.ts': `/** Stub: no DOM-based navigation triangles in React Native */
export type TriangleData = Record<string, never>;
export const handleNavigationTriangle = (..._args: unknown[]): void => {};
/** RN stub — the original class is DOM-only */
export class NavigationItemSafeTriangle {
  constructor(..._args: unknown[]) {}
  destroy(): void {}
}
`,
			'react.ts': `/** Stub: no HTML-attribute filtering in React Native */
export const filterPassingProps = (_props: any, _filter: string[]): Record<string, unknown> => ({});
export const getRootProps = (_props: any, _filter?: string[]): Record<string, unknown> => ({});
`,
		};
		for (const [filename, stub] of Object.entries(webOnlyStubs)) {
			const stubPath = join(utilsDir, filename);
			if (existsSync(stubPath)) {
				writeFileSync(stubPath, stub, 'utf-8');
				console.log(`  [stub] utils/${filename}`);
			}
		}

		// Write per-component overrides (auto-generated first, manual overrides on top)
		const componentsDir = join(RN_DEST, 'components');
		for (const [relPath, content] of Object.entries(ALL_COMPONENT_OVERRIDES)) {
			const destFile = join(componentsDir, relPath);
			ensureDir(join(componentsDir, relPath.split('/')[0]));
			writeFileSync(destFile, content, 'utf-8');
			console.log(`  [override] ${relPath}`);
		}

		// CSS-derived styles are now embedded directly in each component's override
		// using design token references from shared/tokens.ts — no injection needed.

		// Append font provider exports to the generated index.ts
		const indexPath = join(RN_DEST, 'index.ts');
		if (existsSync(indexPath)) {
			const indexContent = readFileSync(indexPath, 'utf-8');
			if (!indexContent.includes('providers/font-provider')) {
				writeFileSync(
					indexPath,
					indexContent +
					`\nexport { DBFontProvider, useDBFont } from './providers/font-provider';\n` +
					`export { DBColorPalette, DBColorPaletteDark, DBTheme } from './shared/tokens';\n` +
					`export type { DBThemeColors } from './shared/tokens';\n` +
					`export { default as DBText } from './components/text/text';\n` +
					`export type { DBTextProps } from './components/text/model';\n` +
					`export { default as DBIconToggle } from './components/icon-toggle/icon-toggle';\n` +
					`export type { DBIconToggleProps, DBIconToggleOption } from './components/icon-toggle/model';\n`,
					'utf-8'
				);
				console.log('  [index] appended DBFontProvider + DBColorPalette exports');
			}
		}

		// -----------------------------------------------------------------------
		// Post-process example files and purge spec/test files
		// -----------------------------------------------------------------------
		cleanExamplesAndPurgeSpecs(RN_DEST);

		console.log('[RN] Done.');
	} catch (err) {
		console.error('[RN] Error:', err);
		throw err;
	}
}
