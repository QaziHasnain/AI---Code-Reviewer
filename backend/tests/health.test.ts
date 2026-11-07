import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("GET /api/health", () => {
  it("returns 200 with expected response structure", async () => {
    const app = await buildApp({ frontendUrl: "http://localhost:3000" });

    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({
      status: "ok",
      service: "AI Code Reviewer API",
    });

    await app.close();
  });
});
