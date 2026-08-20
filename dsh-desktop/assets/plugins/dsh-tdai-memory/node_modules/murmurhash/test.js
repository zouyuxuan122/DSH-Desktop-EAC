const { v3 } = require("./murmurhash");

const fromStr = v3("abc");
const fromBuffer = v3(Buffer.from("abc"));
const fromUnit8Array = v3(new Uint8Array([97, 98, 99]));

if (
  fromStr !== fromBuffer ||
  fromBuffer !== fromUnit8Array ||
  fromStr !== 3017643002
) {
  throw new Error(`Wrong output`);
}
