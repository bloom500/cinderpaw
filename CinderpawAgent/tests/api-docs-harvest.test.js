import { describe, expect, test } from "bun:test";
import { harvestRoutes } from "../../scripts/check-api-docs.mjs";

describe("API route harvesting", () => {
  test("includes every chained method for single-line and multiline registrations", () => {
    const source = `Router::new()
      .route("/items", get(list).post(create))
      .route(
        "/items/:id",
        get(show)
          .patch(update)
          .delete(remove),
      )
      .route("/health", get(health))`;
    expect([...harvestRoutes(source)].sort()).toEqual([
      "DELETE /items/:id", "GET /health", "GET /items", "GET /items/:id",
      "PATCH /items/:id", "POST /items",
    ]);
  });

  test("ignores commented-out routes", () => {
    expect([...harvestRoutes('// .route("/removed", post(old))\n.route("/live", get(live))')])
      .toEqual(["GET /live"]);
  });

  for (const source of [
    '.route("/items", routes)',
    '.route(path_variable, get(list))',
    '.route("/items", get(list).merge(post(create)))',
    '.route("/items", get(list).layer(middleware))',
    'Router::new().merge(other_router)',
    'Router::new().nest("/api", other_router)',
  ]) {
    test(`rejects unsupported shapes instead of dropping routes: ${source}`, () => {
      expect(() => harvestRoutes(source)).toThrow(/Unsupported API/);
    });
  }
});
