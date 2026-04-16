import test from 'node:test';
import assert from 'node:assert/strict';

import { compileSourceWithBundledSolc } from '../functions/api/lib/solc-compile.js';
import { extractSolidityFacts } from '../functions/api/lib/solidity-facts.js';
import { deriveDeterministicFindings } from '../functions/api/lib/deterministic-findings.js';

function deriveFindings(source, compiler = 'pragma:0.8.20', fileName = 'Fixture.sol') {
  const files = [{ name: fileName, content: source }];
  const compiled = compileSourceWithBundledSolc({ compiler, files });
  assert.equal(compiled.status, 'ok');
  const facts = extractSolidityFacts({
    compilerOutput: compiled.compilerOutput,
    files,
  });
  return {
    facts,
    findings: deriveDeterministicFindings(facts),
  };
}

test('flags an uncapped configurable fee that can reach 100%', () => {
  const { findings } = deriveFindings(`
    pragma solidity 0.8.20;
    contract Vault {
      address public owner;
      uint256 public feeBps;
      modifier onlyOwner() { require(msg.sender == owner, "no"); _; }
      function setFeeBps(uint256 value) external onlyOwner {
        feeBps = value;
      }
      function preview(uint256 amount) external view returns (uint256) {
        return amount - ((amount * feeBps) / 10_000);
      }
    }
  `);

  const finding = findings.find((entry) => entry.ruleId === 'fee-uncapped-100');
  assert.ok(finding);
  assert.equal(finding.severity, 'CRITICAL');
  assert.match(finding.summary, /100%/i);
});

test('flags a fee cap that still allows 100%', () => {
  const { findings } = deriveFindings(`
    pragma solidity 0.8.20;
    contract Vault {
      address public owner;
      uint256 public feeBps;
      uint256 public constant MAX_FEE_BPS = 10_000;
      modifier onlyOwner() { require(msg.sender == owner, "no"); _; }
      function setFeeBps(uint256 value) external onlyOwner {
        require(value <= MAX_FEE_BPS, "cap");
        feeBps = value;
      }
      function preview(uint256 amount) external view returns (uint256) {
        return amount - ((amount * feeBps) / 10_000);
      }
    }
  `);

  const finding = findings.find((entry) => entry.ruleId === 'fee-cap-at-least-100');
  assert.ok(finding);
  assert.equal(finding.severity, 'CRITICAL');
});

test('flags a fee cap above 50%', () => {
  const { findings } = deriveFindings(`
    pragma solidity 0.8.20;
    contract Vault {
      address public owner;
      uint256 public feeBps;
      uint256 public constant MAX_FEE_BPS = 6_000;
      modifier onlyOwner() { require(msg.sender == owner, "no"); _; }
      function setFeeBps(uint256 value) external onlyOwner {
        require(value <= MAX_FEE_BPS, "cap");
        feeBps = value;
      }
      function preview(uint256 amount) external view returns (uint256) {
        return amount - ((amount * feeBps) / 10_000);
      }
    }
  `);

  const finding = findings.find((entry) => entry.ruleId === 'fee-cap-over-50');
  assert.ok(finding);
  assert.equal(finding.severity, 'WARNING');
});

test('flags pause controls that block exit', () => {
  const { findings } = deriveFindings(`
    pragma solidity 0.8.20;
    contract Vault {
      bool public paused;
      modifier whenNotPaused() { require(!paused, "paused"); _; }
      function withdraw(uint256 amount) external whenNotPaused {}
      function claim() external whenNotPaused {}
    }
  `);

  const finding = findings.find((entry) => entry.ruleId === 'exit-blocked-by-pause');
  assert.ok(finding);
  assert.match(finding.detail, /withdraw/i);
  assert.match(finding.detail, /claim/i);
});

test('flags blacklist or freeze controls that block transfer or withdraw', () => {
  const { findings } = deriveFindings(`
    pragma solidity 0.8.20;
    contract Token {
      mapping(address => bool) public blacklist;
      mapping(address => bool) public frozen;
      modifier notBlacklisted(address user) { require(!blacklist[user], "blocked"); _; }
      modifier notFrozen(address user) { require(!frozen[user], "frozen"); _; }
      function transfer(address to, uint256 amount) external notBlacklisted(msg.sender) returns (bool) {
        return true;
      }
      function withdraw(uint256 amount) external notFrozen(msg.sender) {}
    }
  `);

  const finding = findings.find((entry) => entry.ruleId === 'blacklist-or-freeze-blocks-user-actions');
  assert.ok(finding);
  assert.match(finding.detail, /transfer/i);
  assert.match(finding.detail, /withdraw/i);
});

test('flags privileged mint and user-targeting burn paths', () => {
  const { findings } = deriveFindings(`
    pragma solidity 0.8.20;
    contract Token {
      address public owner;
      modifier onlyOwner() { require(msg.sender == owner, "no"); _; }
      function mint(address to, uint256 amount) external onlyOwner {}
      function burnFrom(address user, uint256 amount) external onlyOwner {}
    }
  `);

  const mintFinding = findings.find((entry) => entry.ruleId === 'privileged-mint');
  assert.ok(mintFinding);
  assert.equal(mintFinding.severity, 'INFO');
  assert.ok(findings.find((entry) => entry.ruleId === 'privileged-user-burn'));
});

test('does not flag an uncapped fee when a conjunction includes a visible cap', () => {
  const { facts, findings } = deriveFindings(`
    pragma solidity 0.8.20;
    contract Vault {
      uint256 public feeBps;
      uint256 public constant MAX_FEE_BPS = 1_000;

      function setFeeBps(uint256 value) external {
        require(value <= MAX_FEE_BPS && value >= 0, "cap");
        feeBps = value;
      }

      function preview(uint256 amount) external view returns (uint256) {
        return amount - ((amount * feeBps) / 10_000);
      }
    }
  `);

  const feeControl = facts.feeControls.find((entry) => entry.variable === 'feeBps');
  assert.ok(feeControl);
  assert.equal(feeControl.setters[0].capValue, 1000);
  assert.equal(findings.find((entry) => entry.ruleId === 'fee-uncapped-100'), undefined);
});

test('flags privileged upgrade paths without a visible timelock', () => {
  const { findings } = deriveFindings(`
    pragma solidity 0.8.20;
    contract Vault {
      address public owner;
      modifier onlyOwner() { require(msg.sender == owner, "no"); _; }
      function upgradeTo(address implementation) external onlyOwner {}
    }
  `);

  const finding = findings.find((entry) => entry.ruleId === 'upgrade-without-timelock');
  assert.ok(finding);
  assert.equal(finding.severity, 'WARNING');
});
