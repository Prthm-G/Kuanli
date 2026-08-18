import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formatWhatsAppText } from "./format-text";

const html = (s: string | null | undefined) =>
  renderToStaticMarkup(<>{formatWhatsAppText(s)}</>);

describe("formatWhatsAppText", () => {
  it("bolds *text*", () => {
    expect(html("*hello*")).toBe("<strong>hello</strong>");
  });

  it("bolds a currency amount — the reported case", () => {
    expect(html("*₹39,000* total")).toBe("<strong>₹39,000</strong> total");
  });

  it("handles several bold runs on one line", () => {
    expect(html("*LPU* *Distance* *MA*")).toBe(
      "<strong>LPU</strong> <strong>Distance</strong> <strong>MA</strong>",
    );
  });

  it("supports italic, strikethrough and monospace", () => {
    expect(html("_i_")).toBe("<em>i</em>");
    expect(html("~s~")).toBe("<del>s</del>");
    expect(html("```m```")).toContain("<code");
    expect(html("```m```")).toContain("m</code>");
  });

  it("nests bold around italic", () => {
    expect(html("*_both_*")).toBe("<strong><em>both</em></strong>");
  });

  it("leaves arithmetic and lone delimiters alone", () => {
    expect(html("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(html("half * done")).toBe("half * done");
    expect(html("a_b_c")).toBe("a<em>b</em>c");
  });

  it("does not treat space-padded delimiters as markup", () => {
    expect(html("* not bold *")).toBe("* not bold *");
  });

  it("preserves newlines for whitespace-pre-wrap", () => {
    expect(html("*a*\nplain")).toBe("<strong>a</strong>\nplain");
  });

  it("escapes HTML rather than injecting it", () => {
    expect(html("<img src=x onerror=alert(1)>")).not.toContain("<img");
    expect(html("*<b>x</b>*")).toBe("<strong>&lt;b&gt;x&lt;/b&gt;</strong>");
  });

  it("passes through empty input", () => {
    expect(html("")).toBe("");
    expect(html(null)).toBe("");
  });
});
