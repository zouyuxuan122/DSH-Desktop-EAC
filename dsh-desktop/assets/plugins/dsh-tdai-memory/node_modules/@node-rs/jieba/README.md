# `@node-rs/jieba`

![](https://github.com/napi-rs/node-rs/workflows/CI/badge.svg)
![](https://img.shields.io/npm/dm/@node-rs/jieba.svg?sanitize=true)

[jieba-rs](https://github.com/messense/jieba-rs) binding to Node.js

## Without node-gyp

`node-rs/jieba` was prebuilt into binary already, so you don't need fighting with `node-gyp` and c++ toolchain.

## Performance

Due to [jieba-rs is 33% faster than cppjieba](https://blog.paulme.ng/posts/2019-06-30-optimizing-jieba-rs-to-be-33percents-faster-than-cppjieba.html), and N-API is faster than `v8` C++ API, `@node-rs/jieba` is faster than `nodejieba`.

```bash
Benchmark Cut 1184 words result
┌─────────┬──────────────────┬─────────┬────────────────────┬──────────┬─────────┐
│ (index) │ Task Name        │ ops/sec │ Average Time (ns)  │ Margin   │ Samples │
├─────────┼──────────────────┼─────────┼────────────────────┼──────────┼─────────┤
│ 0       │ '@node-rs/jieba' │ '8,246' │ 121266.9342871014  │ '±0.17%' │ 4124    │
│ 1       │ 'nodejieba'      │ '6,392' │ 156439.52799499547 │ '±0.20%' │ 3197    │
└─────────┴──────────────────┴─────────┴────────────────────┴──────────┴─────────┘
Benchmark Cut 246568 words result
┌─────────┬──────────────────┬─────────┬────────────────────┬──────────┬─────────┐
│ (index) │ Task Name        │ ops/sec │ Average Time (ns)  │ Margin   │ Samples │
├─────────┼──────────────────┼─────────┼────────────────────┼──────────┼─────────┤
│ 0       │ '@node-rs/jieba' │ '32'    │ 30760703.470588237 │ '±3.01%' │ 17      │
│ 1       │ 'nodejieba'      │ '19'    │ 51275112.699999996 │ '±2.68%' │ 10      │
└─────────┴──────────────────┴─────────┴────────────────────┴──────────┴─────────┘
Benchmark Tag 1184 words result
┌─────────┬──────────────────┬─────────┬───────────────────┬──────────┬─────────┐
│ (index) │ Task Name        │ ops/sec │ Average Time (ns) │ Margin   │ Samples │
├─────────┼──────────────────┼─────────┼───────────────────┼──────────┼─────────┤
│ 0       │ '@node-rs/jieba' │ '3,174' │ 315048.8916876547 │ '±0.20%' │ 1588    │
│ 1       │ 'nodejieba'      │ '2,672' │ 374213.8870605615 │ '±0.23%' │ 1337    │
└─────────┴──────────────────┴─────────┴───────────────────┴──────────┴─────────┘
Benchmark Tag 246568 words result
┌─────────┬──────────────────┬─────────┬────────────────────┬──────────┬─────────┐
│ (index) │ Task Name        │ ops/sec │ Average Time (ns)  │ Margin   │ Samples │
├─────────┼──────────────────┼─────────┼────────────────────┼──────────┼─────────┤
│ 0       │ '@node-rs/jieba' │ '11'    │ 84886341.7999999   │ '±5.74%' │ 10      │
│ 1       │ 'nodejieba'      │ '7'     │ 125781083.30000004 │ '±4.75%' │ 10      │
└─────────┴──────────────────┴─────────┴────────────────────┴──────────┴─────────┘
```

## Usage

```javascript
import { Jieba } from '@node-rs/jieba'
import { dict } from '@node-rs/jieba/dict'

// load jieba with the default dict
const jieba = Jieba.withDict(dict)

console.info(jieba.cut('我们中出了一个叛徒', false))

// ["我们", "中", "出", "了", "一个", "叛徒"]
```

```javascript
import { Jieba, TfIdf } from '@node-rs/jieba'
import { dict, idf } from '@node-rs/jieba/dict'

const jieba = Jieba.withDict(dict)
const tfIdf = TfIdf.withDict(idf)

tfIdf.extractKeywords(
  jieba,
  '今天纽约的天气真好啊，京华大酒店的张尧经理吃了一只北京烤鸭。后天纽约的天气不好，昨天纽约的天气也不好，北京烤鸭真好吃',
  3,
)

// [
//   { keyword: '北京烤鸭', weight: 1.3904870323222223 },
//   { keyword: '纽约', weight: 1.121759684755 },
//   { keyword: '天气', weight: 1.0766573240983333 }
// ]
```

### Load custom dictionaries

```javascript
import { Jieba } from '@node-rs/jieba'
const customDict = ['哪行 50', '干一行 51', '行一行 52', '行行 53']

const dictBuffer = Buffer.from(customDict.join('\n'), 'utf-8')
const jieba = Jieba.withDict(dictBuffer)

const text = '人要是行干一行行一行，一行行行行行，行行行干哪行都行'
const output = jieba.cut(text, false)
console.log('分词结果⤵️\n', output.join('/'))
// Before: 人/要是/行/干/一行行/一行/，/一行行/行/行/行/，/行/行/行/干/哪/行/都行
// After:  人/要是/行/干一行/行一行/，/一行行/行行/行/，/行行/行/干/哪行/都行
// Pinyin: rén yào shi xíng gàn yì háng xíng yì háng ， yì háng xíng háng háng xíng ， háng háng xíng gàn nǎ háng dōu xíng
```
