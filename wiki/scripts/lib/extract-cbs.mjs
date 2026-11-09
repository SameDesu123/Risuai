// RisuAI의 src/ts/cbs.ts를 실행하지 않고 AST만 읽어서
// registerFunction({...}) 호출에 담긴 문서 정보를 뽑아낸다.
import { parse } from '@babel/parser';

/**
 * @typedef {object} CbsEntry
 * @property {string} name
 * @property {string[]} alias
 * @property {string} description
 * @property {{ message: string, since?: string, replacement?: string } | undefined} deprecated
 * @property {boolean} internalOnly
 * @property {boolean} docOnly
 * @property {number} line
 */

class ExtractError extends Error {}

/** 문자열 리터럴, 치환식 없는 템플릿 리터럴, 그리고 그 둘의 + 연결만 허용한다. */
function staticString(node, what) {
    if (!node) return undefined;
    switch (node.type) {
        case 'StringLiteral':
            return node.value;
        case 'TemplateLiteral':
            if (node.expressions.length > 0) break;
            return node.quasis.map((q) => q.value.cooked).join('');
        case 'BinaryExpression':
            if (node.operator !== '+') break;
            return staticString(node.left, what) + staticString(node.right, what);
    }
    throw new ExtractError(
        `${what}을(를) 정적으로 읽을 수 없습니다 (줄 ${node.loc?.start.line}, 노드 ${node.type}). ` +
            '추출기(scripts/lib/extract-cbs.mjs)를 갱신해야 합니다.',
    );
}

function prop(obj, key) {
    return obj.properties.find(
        (p) =>
            p.type === 'ObjectProperty' &&
            ((p.key.type === 'Identifier' && p.key.name === key) ||
                (p.key.type === 'StringLiteral' && p.key.value === key)),
    )?.value;
}

function walk(node, visit) {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
        const child = node[key];
        if (Array.isArray(child)) child.forEach((c) => walk(c, visit));
        else if (child && typeof child.type === 'string') walk(child, visit);
    }
}

/**
 * @param {string} source cbs.ts 원문
 * @returns {{ entries: CbsEntry[], warnings: string[] }}
 */
export function extractCbs(source) {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
    /** @type {CbsEntry[]} */
    const raw = [];

    walk(ast.program, (node) => {
        if (
            node.type !== 'CallExpression' ||
            node.callee.type !== 'Identifier' ||
            node.callee.name !== 'registerFunction'
        ) {
            return;
        }
        const arg = node.arguments[0];
        if (arg?.type !== 'ObjectExpression') {
            throw new ExtractError(`registerFunction 인자가 객체 리터럴이 아닙니다 (줄 ${node.loc.start.line}).`);
        }
        const line = node.loc.start.line;
        const name = staticString(prop(arg, 'name'), `name(줄 ${line})`);
        const aliasNode = prop(arg, 'alias');
        let alias = [];
        if (aliasNode) {
            if (aliasNode.type !== 'ArrayExpression') {
                throw new ExtractError(`alias가 배열 리터럴이 아닙니다 (줄 ${line}).`);
            }
            alias = aliasNode.elements.map((el) => staticString(el, `alias(줄 ${line})`));
        }
        const description = staticString(prop(arg, 'description'), `description(줄 ${line})`) ?? '';

        let deprecated;
        const depNode = prop(arg, 'deprecated');
        if (depNode) {
            if (depNode.type !== 'ObjectExpression') {
                throw new ExtractError(`deprecated가 객체 리터럴이 아닙니다 (줄 ${line}).`);
            }
            deprecated = {
                message: staticString(prop(depNode, 'message'), `deprecated.message(줄 ${line})`) ?? '',
                since: staticString(prop(depNode, 'since'), `deprecated.since(줄 ${line})`),
                replacement: staticString(prop(depNode, 'replacement'), `deprecated.replacement(줄 ${line})`),
            };
        }

        const internalNode = prop(arg, 'internalOnly');
        const internalOnly = internalNode?.type === 'BooleanLiteral' && internalNode.value === true;
        const callbackNode = prop(arg, 'callback');
        const docOnly = callbackNode?.type === 'StringLiteral' && callbackNode.value === 'doc_only';

        raw.push({ name, alias, description, deprecated, internalOnly, docOnly, line });
    });

    // 앱은 Map에 이름과 별칭을 순서대로 set 하므로 같은 이름이면 나중 등록이 이긴다.
    const warnings = [];
    const lastIndexByName = new Map();
    raw.forEach((e, i) => lastIndexByName.set(e.name, i));
    const entries = raw.filter((e, i) => {
        const keep = lastIndexByName.get(e.name) === i;
        if (!keep) {
            const winner = raw[lastIndexByName.get(e.name)];
            warnings.push(`'${e.name}'가 두 번 등록되어 있습니다 (줄 ${e.line}, ${winner.line}). 나중 것만 문서화합니다.`);
        }
        return keep;
    });

    const owner = new Map();
    for (const e of entries) {
        for (const key of [e.name, ...e.alias]) {
            const prev = owner.get(key);
            if (prev && prev !== e.name) {
                warnings.push(`'${key}'가 '${prev}'와 '${e.name}' 양쪽에 걸려 있습니다. 앱에서는 '${e.name}' 쪽이 이깁니다.`);
            }
            owner.set(key, e.name);
        }
    }

    return { entries, warnings };
}

export { ExtractError };
