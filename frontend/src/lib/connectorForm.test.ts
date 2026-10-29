import { describe, expect, it } from "vitest";
import type { ConnectorField } from "../api/types";
import { SECRET_MARKER, hasStoredSecret, initialValues, splitList, toConfig, validateConnector } from "./connectorForm";

const f = (o: Partial<ConnectorField> & { key: string }): ConnectorField => ({ label: o.key, type: "text", required: false, secret: false, help: "", placeholder: "", ...o });

const webhook = [f({ key: "url", label: "URL", type: "url", required: true }), f({ key: "secret", label: "Signing secret", type: "password", secret: true })];
const email = [f({ key: "recipients", label: "Recipients", type: "list" }), f({ key: "to_members", type: "bool" }), f({ key: "sendgrid_api_key", type: "password", secret: true })];
const sms = [f({ key: "account_sid", required: true }), f({ key: "auth_token", label: "Auth token", type: "password", required: true, secret: true }), f({ key: "to", label: "To", type: "list", required: true })];
const gee = [f({ key: "service_account_json", label: "Service account JSON", type: "textarea", required: true, secret: true })];

describe("connector forms", () => {
  it("builds initial values without exposing secrets", () => {
    const v = initialValues(email, { recipients: ["a@x.io", "b@x.io"], to_members: true, sendgrid_api_key: SECRET_MARKER });
    expect(v).toEqual({ recipients: "a@x.io, b@x.io", to_members: true, sendgrid_api_key: "" });
  });

  it("requires required fields and validates URLs", () => {
    expect(validateConnector(webhook, { url: "", secret: "" })).toHaveProperty("url");
    expect(validateConnector(webhook, { url: "ftp://x", secret: "" }).url).toMatch(/https/);
    expect(validateConnector(webhook, { url: "https://hooks.example.com/x", secret: "" })).toEqual({});
  });

  it("validates the connection name when given", () => {
    expect(validateConnector(webhook, { url: "https://x.io" }, { name: "  " })).toHaveProperty("__name");
  });

  it("validates e-mail lists", () => {
    expect(validateConnector(email, { recipients: "ok@x.io, nope", to_members: false, sendgrid_api_key: "" }).recipients).toMatch(/nope/);
    expect(validateConnector(email, { recipients: "ok@x.io\nalso@x.io", to_members: false, sendgrid_api_key: "" })).toEqual({});
  });

  it("allows blank required secrets when one is stored", () => {
    const stored = { account_sid: "AC1", auth_token: SECRET_MARKER, to: ["+100"] };
    expect(hasStoredSecret(sms[1]!, stored)).toBe(true);
    expect(validateConnector(sms, { account_sid: "AC1", auth_token: "", to: "+100" }, { storedConfig: stored })).toEqual({});
    expect(validateConnector(sms, { account_sid: "AC1", auth_token: "", to: "+100" })).toHaveProperty("auth_token");
  });

  it("validates JSON textareas", () => {
    expect(validateConnector(gee, { service_account_json: "{not json" })).toHaveProperty("service_account_json");
    expect(validateConnector(gee, { service_account_json: '{"type":"service_account"}' })).toEqual({});
  });

  it("converts to API config, omitting blank secrets so they are kept", () => {
    expect(toConfig(email, { recipients: "a@x.io; b@x.io", to_members: true, sendgrid_api_key: "" })).toEqual({ recipients: ["a@x.io", "b@x.io"], to_members: true });
    expect(toConfig(webhook, { url: " https://x.io ", secret: "s3cr3t" })).toEqual({ url: "https://x.io", secret: "s3cr3t" });
    expect(toConfig(webhook, { url: "https://x.io", secret: SECRET_MARKER })).toEqual({ url: "https://x.io" });
  });

  it("splits lists on commas, semicolons and newlines", () => {
    expect(splitList(" a, b;c\n\n d ")).toEqual(["a", "b", "c", "d"]);
  });
});
