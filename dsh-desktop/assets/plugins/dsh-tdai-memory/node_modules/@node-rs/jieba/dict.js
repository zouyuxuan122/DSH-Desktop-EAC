const fs = require('fs')
const { join } = require('path')

module.exports.dict = fs.readFileSync(join(__dirname, 'dict.txt'))
module.exports.idf = fs.readFileSync(join(__dirname, 'idf.txt'))
