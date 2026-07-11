import { readOnlyAnnotations, readOnlyAuthorization } from "./contract.mjs";

export const brickReadInputSchema = {
  type: "object",
  properties: {
    brick: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description: "Brick id, name, or path fragment.",
    },
  },
  required: ["brick"],
  additionalProperties: false,
};
export const brickReadAnnotations = readOnlyAnnotations;
export const brickReadAuthorization = readOnlyAuthorization;
export const brickReadTimeoutMs = 500;
