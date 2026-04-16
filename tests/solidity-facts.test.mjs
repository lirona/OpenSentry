import test from 'node:test';
import assert from 'node:assert/strict';

import { compileSourceWithBundledSolc } from '../functions/api/lib/solc-compile.js';
import { extractSolidityFacts } from '../functions/api/lib/solidity-facts.js';

function compileFacts(source, compiler = 'pragma:0.8.20', fileName = 'Fixture.sol') {
  const files = [{ name: fileName, content: source }];
  const compiled = compileSourceWithBundledSolc({ compiler, files });
  assert.equal(compiled.status, 'ok');
  return extractSolidityFacts({
    compilerOutput: compiled.compilerOutput,
    files,
  });
}

test('extracts contracts and inheritance facts', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Base {}
    contract Vault is Base {}
  `);

  assert.deepEqual(
    facts.contracts.map((entry) => ({ contract: entry.contract, bases: entry.bases })),
    [
      { contract: 'Base', bases: [] },
      { contract: 'Vault', bases: ['Base'] },
    ],
  );
});

test('extracts privileged roles and privileged functions', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Vault {
      address public owner;
      modifier onlyOwner() { require(msg.sender == owner, "no"); _; }
      function setFee(uint256 value) external onlyOwner {}
    }
  `);

  assert.ok(facts.privilegedRoles.some((entry) => entry.role === 'owner'));
  assert.ok(facts.privilegedRoles.some((entry) => entry.role === 'onlyOwner'));
  assert.ok(facts.privilegedFunctions.some((entry) => entry.function === 'setFee'));
});

test('extracts mutable parameters and fee controls', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Vault {
      uint256 public feeBps;
      uint256 public constant MAX_FEE_BPS = 1000;
      address public feeRecipient;

      function setFee(uint256 value) external {
        require(value <= MAX_FEE_BPS, "cap");
        feeBps = value;
      }
    }
  `);

  assert.ok(facts.mutableParameters.some((entry) => entry.function === 'setFee' && entry.writes.includes('feeBps')));
  const feeControl = facts.feeControls.find((entry) => entry.variable === 'feeBps');
  assert.ok(feeControl);
  assert.equal(feeControl.setters[0].capRaw, 'MAX_FEE_BPS');
  assert.equal(feeControl.setters[0].capValue, 1000);
});

test('extracts arbitrary fee scales from setter expressions', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Vault {
      uint256 public fee;
      uint256 public constant WAD = 1e18;

      function setFee(uint256 value) external {
        fee = value / WAD;
      }
    }
  `);

  const feeControl = facts.feeControls.find((entry) => entry.variable === 'fee');
  assert.ok(feeControl);
  assert.equal(feeControl.setters[0].scale, 1e18);
});

test('extracts fee caps from conjunction conditions', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Vault {
      uint256 public feeBps;
      uint256 public constant MAX_FEE_BPS = 1_000;

      function setFee(uint256 value) external {
        require(value <= MAX_FEE_BPS && value >= 0, "cap");
        feeBps = value;
      }
    }
  `);

  const feeControl = facts.feeControls.find((entry) => entry.variable === 'feeBps');
  assert.ok(feeControl);
  assert.equal(feeControl.setters[0].capRaw, 'MAX_FEE_BPS');
  assert.equal(feeControl.setters[0].capValue, 1000);
});

test('extracts upgrade path facts', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Vault {
      address public owner;
      modifier onlyOwner() { require(msg.sender == owner, "no"); _; }
      function upgradeTo(address impl) external onlyOwner {}
    }
  `);

  assert.ok(facts.upgradePaths.some((entry) => entry.function === 'upgradeTo'));
});

test('extracts pause controls and exit function gating', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Vault {
      bool public paused;
      modifier whenNotPaused() { require(!paused, "paused"); _; }
      function withdraw(uint256 amount) external whenNotPaused {}
    }
  `);

  assert.ok(facts.pauseControls.some((entry) => entry.name === 'paused'));
  const exit = facts.userExitFunctions.find((entry) => entry.function === 'withdraw');
  assert.ok(exit);
  assert.equal(exit.gatedByPause, true);
});

test('extracts dependency facts', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    interface IOracle { function latestAnswer() external view returns (int256); }
    contract Vault {
      IOracle public priceOracle;
      address public treasury;
      function quote() external view returns (int256) { return priceOracle.latestAnswer(); }
    }
  `);

  assert.ok(facts.dependencies.some((entry) => entry.category === 'oracle'));
  assert.ok(facts.dependencies.some((entry) => entry.category === 'treasury'));
});

test('extracts token feature facts', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Token {
      mapping(address => bool) public blacklist;
      bool public tradingEnabled;
      uint256 public maxWallet;

      function mint(address to, uint256 amount) external {}
      function burn(address from, uint256 amount) external {}
      function _transfer(address from, address to, uint256 amount) internal {}
      function setBlacklist(address user, bool blocked) external { blacklist[user] = blocked; }
    }
  `);

  assert.ok(facts.tokenFeatures.mintFunctions.some((entry) => entry.name === 'mint'));
  assert.ok(facts.tokenFeatures.burnFunctions.some((entry) => entry.name === 'burn'));
  assert.ok(facts.tokenFeatures.transferHooks.some((entry) => entry.name === '_transfer'));
  assert.ok(facts.tokenFeatures.blacklistControls.length > 0);
  assert.ok(facts.tokenFeatures.tradingToggles.some((entry) => entry.name === 'tradingEnabled'));
  assert.ok(facts.tokenFeatures.maxLimits.some((entry) => entry.name === 'maxWallet'));
});

test('detects fee-on-transfer signals from transfer writes and prefix unary operations', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Token {
      uint256 public feeCounter;

      function transfer(address to, uint256 amount) external returns (bool) {
        ++feeCounter;
        return true;
      }
    }
  `);

  assert.ok(facts.mutableParameters.some((entry) => entry.function === 'transfer' && entry.writes.includes('feeCounter')));
  assert.ok(facts.tokenFeatures.feeOnTransferSignals.some((entry) => entry.name === 'transfer'));
});
