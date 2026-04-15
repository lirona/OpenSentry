import solc0426 from 'solc-0-4-26';
import solc0517 from 'solc-0-5-17';
import solc0612 from 'solc-0-6-12';
import solc076 from 'solc-0-7-6';
import solc0820 from 'solc-0-8-20';
import solc0824 from 'solc-0-8-24';
import solc0828 from 'solc-0-8-28';

export const BUNDLED_SOLC_VERSIONS = Object.freeze([
  Object.freeze({ version: '0.4.26', compiler: solc0426 }),
  Object.freeze({ version: '0.5.17', compiler: solc0517 }),
  Object.freeze({ version: '0.6.12', compiler: solc0612 }),
  Object.freeze({ version: '0.7.6', compiler: solc076 }),
  Object.freeze({ version: '0.8.20', compiler: solc0820 }),
  Object.freeze({ version: '0.8.24', compiler: solc0824 }),
  Object.freeze({ version: '0.8.28', compiler: solc0828 }),
]);

export const BUNDLED_SOLC_BY_VERSION = Object.freeze(
  Object.fromEntries(BUNDLED_SOLC_VERSIONS.map((entry) => [entry.version, entry.compiler])),
);
