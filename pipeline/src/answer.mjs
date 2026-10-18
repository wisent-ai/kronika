// The plan schema as a strict structured-output schema, and the plan read back
// from an answer to it. Strict decoding needs every object to require all of
// its properties and allow no others, so a property the plan schema leaves
// optional is asked for as nullable, and a map (an object whose
// `additionalProperties` holds a schema) as a list of { key, value } entries.
// `planFromAnswer` undoes both. Bounds strict decoding does not carry
// (`minLength`, `minItems`, `default`) are left out of the answer schema; the
// plan read back is still held to the whole plan schema by `validatePlan`.

/** The strict answer schema for `schema`, refusing a construct it cannot carry. */
export function strictAnswerSchema(schema) {
  return strictNode(schema, "#");
}

function strictNode(node, at) {
  if (node.enum) return described(node, { enum: node.enum });
  if (node.type === "string") {
    return described(node, node.pattern === undefined ? { type: "string" } : { type: "string", pattern: node.pattern });
  }
  if (node.type === "boolean") return described(node, { type: "boolean" });
  if (node.type === "array") return described(node, { type: "array", items: strictNode(node.items, `${at}/items`) });
  if (node.type === "object" && node.properties) {
    const required = new Set(node.required);
    const properties = Object.fromEntries(Object.entries(node.properties).map(([name, property]) => {
      const strict = strictNode(property, `${at}/properties/${name}`);
      return [name, required.has(name) ? strict : nullable(strict)];
    }));
    return described(node, strictObject(properties));
  }
  if (node.type === "object" && typeof node.additionalProperties === "object") {
    const entry = strictObject({
      key: { type: "string" },
      value: strictNode(node.additionalProperties, `${at}/additionalProperties`),
    });
    return described(node, { type: "array", items: entry });
  }
  throw new Error(`${at}: a strict answer schema cannot carry ${JSON.stringify(node)}`);
}

function strictObject(properties) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

function described(node, schema) {
  return node.description === undefined ? schema : { ...schema, description: node.description };
}

function nullable(schema) {
  if (schema.enum) return { ...schema, enum: [...schema.enum, null] };
  return { anyOf: [schema, { type: "null" }] };
}

/**
 * The plan an answer to `strictAnswerSchema(schema)` states: a null optional
 * property left out, entries turned back into a map. A value of the wrong
 * shape, or a map naming one key twice, is refused with where it stands.
 */
export function planFromAnswer(answer, schema) {
  return planNode(answer, schema, "plan");
}

function planNode(value, node, at) {
  if (node.enum) return value;
  if (node.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${at} in the model's answer is not a list: ${JSON.stringify(value)}`);
    return value.map((item, index) => planNode(item, node.items, `${at}[${index}]`));
  }
  if (node.type === "object" && node.properties) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${at} in the model's answer is not an object: ${JSON.stringify(value)}`);
    }
    const plan = {};
    for (const [name, property] of Object.entries(node.properties)) {
      if (value[name] !== null) plan[name] = planNode(value[name], property, `${at}.${name}`);
    }
    return plan;
  }
  if (node.type === "object") {
    if (!Array.isArray(value)) throw new Error(`${at} in the model's answer is not a list of entries: ${JSON.stringify(value)}`);
    const map = {};
    for (const entry of value) {
      if (entry === null || typeof entry !== "object" || typeof entry.key !== "string") {
        throw new Error(`${at} in the model's answer holds an entry without a string key: ${JSON.stringify(entry)}`);
      }
      if (Object.hasOwn(map, entry.key)) throw new Error(`${at} in the model's answer names ${entry.key} twice`);
      map[entry.key] = planNode(entry.value, node.additionalProperties, `${at}.${entry.key}`);
    }
    return map;
  }
  return value;
}
