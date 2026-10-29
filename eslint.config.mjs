// Telinha lint: the plugin sources (src/) under the same rules Vencord applies to its plugins, so the code stays
// upstream-style. Typed rules use ./tsconfig.json, which needs the pinned Vencord in .vencord/ (`pnpm bootstrap`).
// SPDX-License-Identifier: GPL-3.0-or-later

import stylistic from "@stylistic/eslint-plugin";
import react from "eslint-plugin-react";
import header from "eslint-plugin-simple-header";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import unusedImports from "eslint-plugin-unused-imports";
import tseslint from "typescript-eslint";

const SOURCES = ["src/**/*.{tsx,ts,mts,mjs,js,jsx}"];

export default tseslint.config(
    { ignores: [".vencord", "dist", "**/node_modules"] },
    {
        files: SOURCES,
        settings: {
            react: {
                version: "18"
            }
        },
        ...react.configs.flat.recommended,
        rules: {
            ...react.configs.flat.recommended.rules,
            "react/react-in-jsx-scope": "off",
            "react/prop-types": "off",
            "react/display-name": "off",
            "react/no-unescaped-entities": "off",
        }
    },
    {
        files: SOURCES,
        plugins: {
            "simple-header": header,
            "@stylistic": stylistic,
            "@typescript-eslint": tseslint.plugin,
            "simple-import-sort": simpleImportSort,
            "unused-imports": unusedImports
        },
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                project: ["./tsconfig.json"],
                tsconfigRootDir: import.meta.dirname
            }
        },
        rules: {
            // GPL header: the plugin files carry Vencord's header style; accept both of Vencord's templates (read from
            // the pinned checkout, not copied here), any author.
            "simple-header/header": [
                "error",
                {
                    "files": [".vencord/scripts/header-new.txt", ".vencord/scripts/header-old.txt"],
                    "templates": { "author": [".*", "Vendicated and contributors"] }
                }
            ],

            // Style Rules
            "@stylistic/jsx-quotes": ["error", "prefer-double"],
            "@stylistic/quotes": ["error", "double", { "avoidEscape": true }],
            "@stylistic/no-mixed-spaces-and-tabs": "error",
            "@stylistic/arrow-parens": ["error", "as-needed"],
            "@stylistic/eol-last": ["error", "always"],
            "@stylistic/no-multi-spaces": "error",
            "@stylistic/no-trailing-spaces": "error",
            "@stylistic/no-whitespace-before-property": "error",
            "@stylistic/semi": ["error", "always"],
            "@stylistic/semi-style": ["error", "last"],
            "@stylistic/space-in-parens": ["error", "never"],
            "@stylistic/block-spacing": ["error", "always"],
            "@stylistic/object-curly-spacing": ["error", "always"],
            "@stylistic/spaced-comment": ["error", "always", { "markers": ["!"] }],
            "@stylistic/no-extra-semi": "error",

            // TS Rules
            "@stylistic/function-call-spacing": ["error", "never"],

            // ESLint Rules
            "yoda": "error",
            "eqeqeq": ["error", "always", { "null": "ignore" }],
            "prefer-destructuring": ["error", {
                "VariableDeclarator": { "array": false, "object": true },
                "AssignmentExpression": { "array": false, "object": false }
            }],
            "operator-assignment": ["error", "always"],
            "no-useless-computed-key": "error",
            "no-unneeded-ternary": ["error", { "defaultAssignment": false }],
            "no-invalid-regexp": "error",
            "no-constant-condition": ["error", { "checkLoops": false }],
            "no-duplicate-imports": "error",
            "@typescript-eslint/dot-notation": [
                "error",
                {
                    "allowPrivateClassPropertyAccess": true,
                    "allowProtectedClassPropertyAccess": true
                }
            ],
            "no-useless-escape": [
                "error",
                {
                    "allowRegexCharacters": ["i"]
                }
            ],
            "no-fallthrough": "error",
            "for-direction": "error",
            "no-async-promise-executor": "error",
            "no-cond-assign": "error",
            "no-dupe-else-if": "error",
            "no-duplicate-case": "error",
            "no-irregular-whitespace": "error",
            "no-loss-of-precision": "error",
            "no-misleading-character-class": "error",
            "no-prototype-builtins": "error",
            "no-regex-spaces": "error",
            "no-shadow-restricted-names": "error",
            "no-unexpected-multiline": "error",
            "no-unsafe-optional-chaining": "error",
            "no-useless-backreference": "error",
            "use-isnan": "error",
            "prefer-const": ["error", { destructuring: "all" }],
            "prefer-spread": "error",
            // These are old deprecated browser globals which may be used by mistake, e.g. `addEventListener(e => console.log(event))`
            "no-restricted-globals": ["error", "event", "name"],
            // Vencord enforces this with a patched eslint-plugin-path-alias (only `../` imports that a path alias
            // covers). Inside src/plugins/telinha every `../` is covered by @plugins/telinha/*, so the core rule is
            // equivalent and needs no patched dependency.
            "no-restricted-imports": ["error", {
                "patterns": [{ "regex": "^\\.\\./", "message": "Import through the path alias (@plugins/telinha/...) instead of ../" }]
            }],

            // Plugin Rules
            "simple-import-sort/imports": "error",
            "simple-import-sort/exports": "error",
            "unused-imports/no-unused-imports": "error"
        }
    }
);
