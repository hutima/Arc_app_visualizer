// Polyfill DOMParser / XMLSerializer / Element on the Node global so we can
// reuse the existing src/parser/gpx-parser.js and src/serializer/gpx-serializer.js
// without modification. xmldom is small (~70KB) and well-trodden.
//
// xmldom's NamedNodeMap / NodeList / HTMLCollection are array-likes but
// don't ship Symbol.iterator. The browser parser uses `for...of` on them,
// so we add the iterator method here by probing live instances.

import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

if (typeof globalThis.DOMParser === "undefined") globalThis.DOMParser = DOMParser;
if (typeof globalThis.XMLSerializer === "undefined") globalThis.XMLSerializer = XMLSerializer;

function arrayLikeIterator() {
  return function* () {
    for (let i = 0; i < this.length; i++) yield this[i];
  };
}

(function patchIterables() {
  const doc = new DOMParser().parseFromString(
    `<r a="1"><c/><c/></r>`,
    "application/xml",
  );
  const elt = doc.documentElement;
  const targets = [
    elt.attributes,
    elt.childNodes,
    doc.getElementsByTagName("c"),
    doc.getElementsByTagNameNS("*", "c"),
  ];
  for (const t of targets) {
    if (!t) continue;
    const proto = Object.getPrototypeOf(t);
    if (proto && !proto[Symbol.iterator]) {
      Object.defineProperty(proto, Symbol.iterator, {
        value: arrayLikeIterator(),
        configurable: true,
        writable: true,
      });
    }
  }
})();

// The browser parser checks for `<parsererror>` to detect malformed XML.
// xmldom emits parse errors via a callback; we wrap to mirror the browser
// behaviour: an error injects a <parsererror> element so the existing
// detection path works.
const RealDOMParser = globalThis.DOMParser;
globalThis.DOMParser = class extends RealDOMParser {
  constructor() {
    super({
      errorHandler: {
        warning: () => {},
        error: msg => { this._lastErr = String(msg || "parse error"); },
        fatalError: msg => { this._lastErr = String(msg || "fatal parse error"); },
      },
    });
  }
  parseFromString(str, type) {
    this._lastErr = null;
    const doc = super.parseFromString(str, type);
    if (this._lastErr && doc && doc.documentElement) {
      const e = doc.createElement("parsererror");
      e.textContent = this._lastErr;
      doc.documentElement.insertBefore(e, doc.documentElement.firstChild);
    }
    return doc;
  }
};
