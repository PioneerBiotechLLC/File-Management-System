import { describe, expect, it } from "vitest";
import { declaredCharset, decodeEntities, htmlToText } from "./html-text";

describe("htmlToText", () => {
  it("drops markup, scripts and styles, and keeps the shape of blocks, lists and tables", () => {
    const html = `<!DOCTYPE html><html><head><title>Quotation  QT-2291</title>
      <style>p { color: red }</style><script>alert("x")</script></head>
      <body><!-- draft -->
      <h1>Quotation <b>QT-2291</b></h1>
      <p>To: Gulf&nbsp;Pharmacy &amp; Co.<br>Date: 2026-03-15</p>
      <table><tr><th>Item</th><th>Qty</th><th>Price</th></tr>
      <tr><td>Insulin glargine</td><td>500</td><td>2.50 AED</td></tr></table>
      <ul><li>Delivery: 2 weeks</li><li>Payment: 30 days</li></ul>
      <div>Total: 1,250.50&#160;AED &#x20AC; &euro;</div>
      </body></html>`;
    expect(htmlToText(html)).toBe(
      // The title is not repeated when the page starts with the same heading.
      [
        "Quotation QT-2291",
        "",
        "To: Gulf Pharmacy & Co.",
        "Date: 2026-03-15",
        "",
        "Item | Qty | Price",
        "Insulin glargine | 500 | 2.50 AED",
        "",
        "- Delivery: 2 weeks",
        "- Payment: 30 days",
        "",
        "Total: 1,250.50 AED € €",
      ].join("\n"),
    );
  });

  it("returns nothing for a page with no text", () => {
    expect(htmlToText("<html><head><style>a{}</style></head><body><div></div></body></html>")).toBe("");
  });

  it("leaves unknown entities alone and refuses impossible code points", () => {
    expect(decodeEntities("a &unknownthing; b &#0; c &#x1F600;")).toBe("a &unknownthing; b &#0; c 😀");
  });
});

describe("declaredCharset", () => {
  const bytes = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
  it("reads a legacy charset from the meta tag and ignores UTF-8 or nonsense", () => {
    expect(declaredCharset(bytes('<meta http-equiv="Content-Type" content="text/html; charset=windows-1256">'))).toBe("windows-1256");
    expect(declaredCharset(bytes("<meta charset='ISO-8859-6'>"))).toBe("iso-8859-6");
    expect(declaredCharset(bytes('<meta charset="utf-8">'))).toBeNull();
    expect(declaredCharset(bytes('<meta charset="x-made-up">'))).toBeNull();
    expect(declaredCharset(bytes("<p>no meta</p>"))).toBeNull();
  });
});
