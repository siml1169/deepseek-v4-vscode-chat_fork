import { check, checkDeep, summary } from "./helpers/check.mjs";
import { selectAdvertisedTools } from "../out/tool_selection.js";
import { toWireName } from "../out/tool_names.js";

const names = Array.from({ length: 140 }, (_, i) => `mcp.tool.${i}`);
const tools = names.map((name) => ({ type: "function", function: { name: toWireName(name) } }));
const reverse = new Map(names.map((name) => [toWireName(name), name]));
const selectedNames = (preferred) => selectAdvertisedTools(tools, reverse, preferred).map((tool) => reverse.get(tool.function.name));

checkDeep("default retains first 128 in host order", selectedNames([]), names.slice(0, 128));
checkDeep("explicit last tool retained without reordering", selectedNames([names[139]]), [...names.slice(0, 127), names[139]]);
checkDeep("preferred setting order does not change host order", selectedNames([names[139], names[138]]), [...names.slice(0, 126), names[138], names[139]]);
checkDeep("unknown names cannot enable tools", selectedNames(["unavailable"]), names.slice(0, 128));
checkDeep("wire alias cannot select a different host name", selectedNames([tools[139].function.name]), names.slice(0, 128));
checkDeep("invalid configuration safely defaults", selectedNames("bad"), names.slice(0, 128));
checkDeep("duplicate preferences do not consume slots", selectedNames([names[139], names[139], null, 42]), [...names.slice(0, 127), names[139]]);
checkDeep("over 128 preferences retain first 128 preferred in host order", selectedNames([...names].reverse()), names.slice(0, 128));
checkDeep("below cap no reordering or omission", selectAdvertisedTools(tools.slice(0, 3), reverse, [names[2]]), tools.slice(0, 3));
check("empty set remains empty", selectAdvertisedTools([], reverse, names).length, 0);
check("selection does not mutate caller's list", tools.length, 140);
check("selection preserves definitions", selectAdvertisedTools(tools, reverse, [names[139]])[127] === tools[139], true);
summary("unit_tool_selection");
