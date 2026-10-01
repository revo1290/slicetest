import { describe, expect, it } from "vitest";
import { allowedValues, valueFor } from "../src/factory.js";

describe("allowedValues", () => {
  it.each([
    ["postgres text", "CHECK ((choice = ANY (ARRAY['a'::text, 'b'::text])))"],
    ["postgres varchar", "CHECK (((choice)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])))"],
    ["mysql", "(`choice` in (_utf8mb4'a',_utf8mb4'b'))"],
    ["sqlite", "choice IN ('a', 'b')"],
  ])("reads the allowed values from a %s check", (_, check) => {
    expect(allowedValues("choice", [check])).toEqual(["a", "b"]);
  });

  it("ignores checks on other columns and checks without a list", () => {
    expect(allowedValues("choice", ["other_choice IN ('x')", "char_length(choice) > 0"])).toBeUndefined();
  });
});

describe("valueFor", () => {
  const col = (type: string, name = "c", maxLength?: number) => ({ name, type, nullable: false, hasDefault: false, maxLength });

  it("makes values of the column's type, distinct per row", () => {
    expect(valueFor("t", col("integer"), 3)).toBe(3);
    expect(valueFor("t", col("uuid"), 26)).toBe("00000000-0000-4000-8000-00000000001a");
    expect(valueFor("t", col("timestamp with time zone"), 1)).toBe("2026-01-01 00:00:01");
    expect(valueFor("t", col("date"), 2)).toBe("2026-01-02");
    expect(valueFor("t", col("boolean"), 1)).toBe(false);
    expect(valueFor("t", col("jsonb"), 1)).toBe("{}");
    expect(valueFor("users", col("text", "email"), 4)).toBe("users-4@example.test");
    expect(valueFor("t", col("varchar(3)", "currency", 3), 7)).toBe("007");
    expect(valueFor("t", { ...col("USER-DEFINED"), values: ["draft", "live"] }, 1)).toBe("draft");
  });

  it("names the column to pass when it can't make a value", () => {
    expect(() => valueFor("places", col("geometry", "location"), 1)).toThrow('db.make("places", { location: ... })');
  });
});
