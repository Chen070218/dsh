/** analyze_dependencies 工具的测试夹具构造器（避免每个用例重复写依赖装配）。 */
import { createAnalyzeDependenciesTool } from '../../lib/tools/analyze-dependencies.js'
import { createLogger } from '../../lib/util/logger.js'

export function analyzeDependenciesToolFixture(allowedRoots: string[] = [], maxFiles = 200) {
  return createAnalyzeDependenciesTool({
    defaults: { allowedRoots, maxFiles, maxFileBytes: 262144 },
    logger: createLogger({ sink: () => {}, level: 'error' }),
  })
}
