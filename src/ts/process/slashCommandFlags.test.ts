import { describe, expect, it } from "vitest";
import {
    getCommandFlag,
    getCommandNameFromInput,
    getRegexArgNames,
    getScriptRegexFlags,
    hasRegexFlag,
    isAnchoredToCommand,
    isValidCommandName,
    setCommandFlag,
    toggleRegexFlag,
} from "./slashCommandFlags";

describe("toggleRegexFlag", () => {
    it("adds and removes plain flags", () => {
        expect(toggleRegexFlag("g", "i")).toBe("gi");
        expect(toggleRegexFlag("gi", "i")).toBe("g");
    });

    it("does not touch letters inside custom tags", () => {
        expect(toggleRegexFlag("g<move_top>m", "m")).toBe("g<move_top>");
        expect(toggleRegexFlag("g<cbs>s", "s")).toBe("g<cbs>");
        expect(toggleRegexFlag("g<command summary>", "m")).toBe("g<command summary>m");
        expect(toggleRegexFlag("g<command summary>i", "i")).toBe("g<command summary>");
    });

    it("toggles custom tags as a whole", () => {
        expect(toggleRegexFlag("g", "<cbs>")).toBe("g<cbs>");
        expect(toggleRegexFlag("g<cbs>", "<cbs>")).toBe("g");
    });
});

describe("hasRegexFlag", () => {
    it("ignores letters inside tags", () => {
        expect(hasRegexFlag("g<move_top>", "m")).toBe(false);
        expect(hasRegexFlag("g<move_top>", "<move_top>")).toBe(true);
    });
});

describe("command flag", () => {
    it("reads the command name", () => {
        expect(getCommandFlag("g<command roll>")).toBe("roll");
        expect(getCommandFlag("g<order 2, command 주사위>")).toBe("주사위");
        expect(getCommandFlag("g<order 2>")).toBeNull();
        expect(getCommandFlag(undefined)).toBeNull();
    });

    it("sets, replaces and removes the command name", () => {
        expect(setCommandFlag("g", "roll")).toBe("g<command roll>");
        expect(setCommandFlag("g<command roll>", "/dice")).toBe("g<command dice>");
        expect(setCommandFlag("g<command roll>", "")).toBe("g");
        expect(setCommandFlag("g<order 2, command roll><cbs>", "")).toBe("g<order 2><cbs>");
        expect(setCommandFlag("g", "a,b>c")).toBe("g<command abc>");
        expect(setCommandFlag("g", "^/hello")).toBe("g<command hello>");
        expect(setCommandFlag("g", "^\\/hello")).toBe("g<command hello>");
        expect(setCommandFlag("g", " /hello ")).toBe("g<command hello>");
    });
});

describe("helpers", () => {
    it("validates command names", () => {
        expect(isValidCommandName("roll")).toBe(true);
        expect(isValidCommandName("주사위")).toBe(true);
        expect(isValidCommandName("my-cmd_2")).toBe(true);
        expect(isValidCommandName("two words")).toBe(false);
        expect(isValidCommandName("a>b")).toBe(false);
    });

    it("extracts named groups as arguments", () => {
        expect(getRegexArgNames("^/roll (?<count>\\d+)d(?<면>\\d+)")).toEqual(["count", "면"]);
        expect(getRegexArgNames("^/roll (?:x)(?<=a)(?<!b)")).toEqual([]);
    });

    it("derives stateless regex flags", () => {
        expect(getScriptRegexFlags("g<command roll>i", true)).toBe("i");
        expect(getScriptRegexFlags("gim", false)).toBe("u");
    });

    it("parses the command name from input", () => {
        expect(getCommandNameFromInput("/roll 2d6")).toBe("roll");
        expect(getCommandNameFromInput("/roll")).toBe("roll");
        expect(getCommandNameFromInput("hello")).toBeNull();
        expect(getCommandNameFromInput("/")).toBeNull();
    });

    it("detects anchored IN patterns", () => {
        expect(isAnchoredToCommand("^/roll (\\d+)", "roll")).toBe(true);
        expect(isAnchoredToCommand("^\\/roll", "roll")).toBe(true);
        expect(isAnchoredToCommand("/roll", "roll")).toBe(false);
    });
});
