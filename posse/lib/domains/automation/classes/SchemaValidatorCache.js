import Ajv from "ajv";

const OPTIONS = { strict: true, allErrors: false, validateFormats: false, ownProperties: true };

// Manifests are parsed again on every load. Ajv keys its internal cache by
// object identity, so retaining those parsed schemas grows the owner forever.
export class SchemaValidatorCache {
  constructor(limit = 256) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Invalid validator cache limit");
    this.limit = limit;
    this.validators = new Map();
    this.formatter = new Ajv(OPTIONS);
  }

  compile(schema) {
    const key = JSON.stringify(schema);
    let validate = this.validators.get(key);
    if (validate) this.validators.delete(key);
    else {
      // Ajv also retains generated-code scope references after removeSchema().
      // Give each cached validator its own compiler so eviction releases both.
      validate = new Ajv(OPTIONS).compile(schema);
    }
    this.validators.set(key, validate);
    if (this.validators.size > this.limit) this.validators.delete(this.validators.keys().next().value);
    return validate;
  }

  errorsText(errors) { return this.formatter.errorsText(errors); }
}
