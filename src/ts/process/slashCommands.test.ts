import { beforeEach, describe, expect, it, vi } from "vitest";
import type { character, customscript } from "../storage/database.svelte";

const database: { presetRegex: customscript[] } = { presetRegex: [] };
let modules: { name: string, regex?: customscript[] }[] = [];

vi.mock("../storage/database.svelte", () => ({
    getDatabase: () => database,
}));

vi.mock("./modules", () => ({
    getModules: () => modules,
}));

vi.mock("../parser/parser.svelte", () => ({
    risuChatParser: (data: string) => data.replaceAll("{{prefix}}", "/roll"),
}));

import { filterSlashCommands, findSlashCommandMismatch, getCustomSlashCommands, getSlashCommands } from "./slashCommands";

const script = (v: Partial<customscript>): customscript => ({
    comment: "",
    in: "",
    out: "",
    type: "editinput",
    ableFlag: true,
    flag: "g",
    ...v,
});

const char = (scripts: customscript[]) => ({
    type: "character",
    name: "Risu",
    customscript: scripts,
}) as unknown as character;

describe("slash commands", () => {
    beforeEach(() => {
        database.presetRegex = [];
        modules = [];
    });

    it("collects command scripts from preset, character and modules", () => {
        database.presetRegex = [script({ in: "^/ooc (.+)", flag: "g<command ooc>", comment: "Out of character" })];
        modules = [{ name: "Dice", regex: [script({ in: "^/roll (?<count>\\d+)d(?<sides>\\d+)", flag: "g<command roll>" })] }];
        const commands = getCustomSlashCommands(char([script({ in: "^/status", flag: "g<command status>" })]));

        expect(commands.map((c) => [c.name, c.source, c.sourceName])).toEqual([
            ["ooc", "preset", undefined],
            ["status", "character", "Risu"],
            ["roll", "module", "Dice"],
        ]);
        expect(commands[0].description).toBe("Out of character");
        expect(commands[2].usage).toBe("/roll <count> <sides>");
    });

    it("skips scripts that cannot act as commands", () => {
        const commands = getCustomSlashCommands(char([
            script({ in: "^/a", flag: "g<command a>", type: "editoutput" }),
            script({ in: "^/b", flag: "g<command b>", ableFlag: false }),
            script({ in: "^/send", flag: "g<command send>" }),
            script({ in: "^/two words", flag: "g<command two words>" }),
            script({ in: "^/plain", flag: "g" }),
        ]));
        expect(commands).toEqual([]);
    });

    it("does not offer regex commands in group chats", () => {
        database.presetRegex = [script({ in: "^/ooc", flag: "g<command ooc>" })];
        expect(getCustomSlashCommands({ type: "group" } as any)).toEqual([]);
    });

    it("lists built-ins first and each name once", () => {
        const commands = getSlashCommands(char([
            script({ in: "^/roll (\\d+)$", flag: "g<command roll>" }),
            script({ in: "^/roll$", flag: "g<command roll>" }),
        ]));
        expect(commands[0].source).toBe("builtin");
        expect(commands.filter((c) => c.name === "roll")).toHaveLength(1);
        expect(commands.some((c) => c.name === "multisend")).toBe(false);
    });

    it("filters by prefix before partial matches", () => {
        const commands = getSlashCommands(char([]));
        const names = filterSlashCommands(commands, "var").map((c) => c.name);
        expect(names).toEqual(["setvar", "addvar", "getvar"]);
        expect(filterSlashCommands(commands, "se")[0].name).toBe("send");
    });

    it("reports mismatched input only for registered commands", () => {
        const c = char([
            script({ in: "^/roll (\\d+)d(\\d+)$", flag: "g<command roll>" }),
            script({ in: "^/roll$", flag: "g<command roll>" }),
        ]);
        expect(findSlashCommandMismatch(c, "/roll 2d6")).toBeNull();
        expect(findSlashCommandMismatch(c, "/roll")).toBeNull();
        expect(findSlashCommandMismatch(c, "/roll abc")?.name).toBe("roll");
        expect(findSlashCommandMismatch(c, "/unknown abc")).toBeNull();
        expect(findSlashCommandMismatch(c, "/send hi")).toBeNull();
        expect(findSlashCommandMismatch(c, "hello")).toBeNull();
    });

    it("respects the case flag and CBS parsing of IN", () => {
        const c = char([
            script({ in: "^/shout", flag: "g<command shout>i" }),
            script({ in: "{{prefix}} \\d+", flag: "g<command roll><cbs>" }),
        ]);
        expect(findSlashCommandMismatch(c, "/SHOUT")).toBeNull();
        expect(findSlashCommandMismatch(c, "/roll 3")).toBeNull();
        expect(findSlashCommandMismatch(c, "/roll x")?.name).toBe("roll");
    });

    it("does not block sending when IN is not a valid regex", () => {
        const c = char([script({ in: "^/bad(", flag: "g<command bad>" })]);
        expect(findSlashCommandMismatch(c, "/bad")).toBeNull();
    });
});
