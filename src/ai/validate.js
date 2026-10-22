// A small JSON Schema validator, covering exactly the keywords the schemas in
// contract.js use: type (one or a list; "integer" too), const, enum,
// required, properties, additionalProperties: false, items, minimum,
// maximum, pattern. `default` is documentation only and ignored.
//
// validate(schema, value) returns a list of problems, each
// { path: '$.filters[0].op', message: 'must be one of eq, neq, ...' }.
// An empty list means the value is valid.

const typeOf = (v) => {
    if (v === null) return 'null'
    if (Array.isArray(v)) return 'array'
    return typeof v // 'object' | 'string' | 'number' | 'boolean' | ...
}

function matchesType(value, type) {
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
    return typeOf(value) === type
}

const show = (v) => JSON.stringify(v)

export function validate(schema, value, path = '$') {
    const errors = []
    const fail = (message) => errors.push({ path, message })

    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type]
        if (!types.some(t => matchesType(value, t))) {
            fail(`must be ${types.join(' or ')}, got ${typeOf(value)}`)
            return errors // nothing else makes sense to check
        }
    }
    if ('const' in schema && value !== schema.const) fail(`must be ${show(schema.const)}, got ${show(value)}`)
    if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(', ')}, got ${show(value)}`)

    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) fail(`must be at least ${schema.minimum}, got ${value}`)
        if (schema.maximum !== undefined && value > schema.maximum) fail(`must be at most ${schema.maximum}, got ${value}`)
    }
    if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) {
        fail(`must match ${schema.pattern}, got ${show(value)}`)
    }

    if (typeOf(value) === 'object') {
        for (const key of schema.required || []) {
            if (!(key in value)) errors.push({ path: `${path}.${key}`, message: 'is required' })
        }
        const props = schema.properties || {}
        for (const [key, v] of Object.entries(value)) {
            if (key in props) errors.push(...validate(props[key], v, `${path}.${key}`))
            else if (schema.additionalProperties === false) errors.push({ path: `${path}.${key}`, message: 'is not allowed here' })
        }
    }

    if (Array.isArray(value) && schema.items) {
        value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)))
    }
    return errors
}

// "$.filters[0].op must be one of ...; $.limit must be integer"
export function describeErrors(errors) {
    return errors.map(e => `${e.path} ${e.message}`).join('; ')
}
