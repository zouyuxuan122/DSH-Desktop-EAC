# node-murmurhash

**NOTE:** This is a port of [Gary Court's excellent work](https://github.com/garycourt/murmurhash-js), to a commonJS module that can be easily included into a node.js project or the browser. I take no credit for the implementation. I am simply making it easier to use for others.

An optimized JavaScript implementation of the MurmurHash algorithms.

These algorithms take a JavaScript string (and a seed), and quickly create a non-cryptographic 32-bit hash from it. And by quick I mean sub-millisecond performance.

More information about these algorithms can be found at:

* [MurmurHash Homepage](http://sites.google.com/site/murmurhash/)
* [Wikipedia Entry on MurmurHash](http://en.wikipedia.org/wiki/MurmurHash)

## Installation

Install it in your browser:

```html
<script type="text/javascript" src="murmurhash.js"></script>
```

To support older browsers you need to use TextEncoder [polyfill](https://developer.mozilla.org/en-US/docs/Web/API/TextEncoder#Polyfill)

or in node.js

```
npm install murmurhash
```

```js
murmurhash = require('murmurhash')
```

Both version 2 and 3 of the MurmurHash algorithm are supported:

```js
// generates a v2 hash
murmurhash.v2("some input", "some seed value (optional)")

// generates a v3 hash
murmurhash.v3("some input", "some seed value (optional)")
```

## License (MIT)

Copyright (c) 2020 Gary Court, Derek Perez

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
