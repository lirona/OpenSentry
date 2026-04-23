export function buildOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['agent', 'severity', 'summary', 'findings'],
    properties: {
      agent: { type: 'string' },
      severity: { type: 'string', enum: ['SAFE', 'INFO', 'WARNING', 'CRITICAL'] },
      summary: { type: 'string' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['check', 'severity', 'location', 'summary', 'detail', 'user_impact'],
          properties: {
            check: { type: 'string' },
            severity: { type: 'string', enum: ['SAFE', 'INFO', 'WARNING', 'CRITICAL'] },
            location: { type: 'string' },
            summary: { type: 'string' },
            detail: { type: 'string' },
            user_impact: { type: 'string' },
          },
        },
      },
    },
  };
}
