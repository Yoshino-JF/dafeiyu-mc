// The fixed [act] failure reasons (docs/log-spec.md). Its own module so dafeiyu_log.js and failure-reasons.js can both import it
// without a cycle.
export const ACT_REASONS = ['no_path', 'out_of_reach', 'need_tool', 'protected', 'blocked', 'not_found', 'timeout', 'refused', 'op_denied'];
