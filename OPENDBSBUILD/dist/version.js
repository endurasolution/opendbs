"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VERSION = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
function readJson(file) {
    try {
        return JSON.parse(fs_1.default.readFileSync(file, 'utf-8'));
    }
    catch {
        return null;
    }
}
const pkg = readJson(path_1.default.join(__dirname, '..', 'package.json')) ?? {};
const build = readJson(path_1.default.join(__dirname, 'build-info.json')) ?? {};
exports.VERSION = {
    name: 'OpenDBS',
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    builtAt: typeof build.builtAt === 'string' ? build.builtAt : null,
    commit: typeof build.commit === 'string' ? build.commit : null,
};
//# sourceMappingURL=version.js.map