// js-yaml 是 @deepseek-ai/dsh 的传递依赖,无自带类型声明;此处提供最小
// 声明,满足 checkJs 检查(loadDshYamlDialect 使用 Type/JSON_SCHEMA)。
declare module 'js-yaml' {
  const yaml: any;
  export = yaml;
}
