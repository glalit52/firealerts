import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorType } from "../api/types";
import { ConnectorForm } from "./ConnectorForm";

const spec: ConnectorType = {
  category: "notification",
  label: "Webhook",
  description: "POST signed JSON to your system.",
  fields: [
    { key: "url", label: "URL", type: "url", required: true, secret: false, help: "", placeholder: "https://example.com/hook" },
    { key: "secret", label: "Signing secret", type: "password", required: false, secret: true, help: "", placeholder: "" },
  ],
};

describe("<ConnectorForm>", () => {
  it("renders fields from the catalogue and blocks invalid submits", () => {
    const onSubmit = vi.fn();
    render(<ConnectorForm spec={spec} onSubmit={onSubmit} onCancel={() => undefined} />);
    expect(screen.getByLabelText(/URL/)).toBeTruthy();
    expect(screen.getByLabelText(/Signing secret/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /add connection/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/URL is required/);
  });

  it("submits a cleaned config", () => {
    const onSubmit = vi.fn();
    render(<ConnectorForm spec={spec} onSubmit={onSubmit} onCancel={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/URL/), { target: { value: "https://hooks.example.com/fire" } });
    fireEvent.click(screen.getByRole("button", { name: /add connection/i }));
    expect(onSubmit).toHaveBeenCalledWith({ name: "Webhook", enabled: true, config: { url: "https://hooks.example.com/fire" } });
  });
});
