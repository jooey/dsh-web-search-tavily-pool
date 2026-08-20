/* Host-face Typert manifest for dsh-web-search-tavily-pool (hand-written).
 * Every codec — parameters AND results — must be strict zod v4: the typert
 * loader rejects src-json codecs anywhere in a contributed manifest. */
import { z } from "zod";

const IndexParam = z.number().int().min(1);
const KeyParam = z.string().min(1);

const KeyView = z.object({
	index: z.number().int().min(1),
	masked: z.string(),
	status: z.enum(["active", "cooling", "disabled"]),
	cooldownSecondsLeft: z.number().int().min(0)
});

const ListResult = z.object({
	keys: z.array(KeyView),
	total: z.number().int().min(0),
	active: z.number().int().min(0)
});

const TestItem = z.object({
	index: z.number().int().min(1).optional(),
	masked: z.string(),
	ok: z.boolean(),
	ms: z.number().int().min(0),
	error: z.string().optional()
});

const TestResult = z.object({
	results: z.array(TestItem),
	at: z.string()
});

const strict = (typeSymbol, schema) => ({ mode: "strict", typeSymbol: `dsh-web-search-tavily-pool/types#${typeSymbol}`, schema });
const param = (name, typeSymbol, schema) => ({ name, wire: name, source: "json", codec: strict(typeSymbol, schema) });

const endpoint = (method, parameters, typeSymbol, schema) => ({
	id: `dsh-web-search-tavily-pool#tavilyAdmin/${method}`,
	service: "tavilyAdmin",
	namespace: "tavilyAdmin",
	method,
	invocation: { kind: "direct" },
	parameters,
	result: strict(typeSymbol, schema),
	sourceLocation: { file: "lib/index.js", line: 1, column: 1 }
});

export const TYPERT = {
	package: "dsh-web-search-tavily-pool",
	face: "host",
	schemas: [],
	invocations: [
		endpoint("listKeys", [], "TavilyAdminList", ListResult),
		endpoint("addKey", [param("key", "TavilyKey", KeyParam)], "TavilyAdminList", ListResult),
		endpoint("removeKey", [param("index", "TavilyKeyIndex", IndexParam)], "TavilyAdminList", ListResult),
		endpoint("toggleKey", [param("index", "TavilyKeyIndex", IndexParam)], "TavilyAdminList", ListResult),
		endpoint("testKey", [param("index", "TavilyKeyIndex", IndexParam)], "TavilyAdminTestItem", TestItem),
		endpoint("testAll", [], "TavilyAdminTest", TestResult),
		endpoint("resetCooldowns", [], "TavilyAdminList", ListResult)
	],
	model: { services: [], events: [], objects: [] }
};

export default TYPERT;
