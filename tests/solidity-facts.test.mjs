import test from 'node:test';
import assert from 'node:assert/strict';

import { compileSourceWithBundledSolc } from '../functions/api/lib/solc-compile.js';
import { extractSolidityFacts, __internal } from '../functions/api/lib/solidity-facts.js';

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

test('extracts explicit fee scales from setter expressions', () => {
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
  assert.equal(feeControl.setters[0].scale, null);
  assert.equal(feeControl.setters[0].scaleExact, '1000000000000000000');
});

test('does not infer fee scales from arbitrary denominators', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Vault {
      uint256 public fee;

      function setFee(uint256 value) external {
        fee = value / 2;
      }
    }
  `);

  const feeControl = facts.feeControls.find((entry) => entry.variable === 'fee');
  assert.ok(feeControl);
  assert.equal(feeControl.setters[0].scale, null);
});

test('infers non-canonical named scales when used as the division denominator', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Vault {
      uint256 public fee;
      uint256 public constant SCALE = 1e12;

      function setFee(uint256 value) external {
        fee = value / SCALE;
      }
    }
  `);

  const feeControl = facts.feeControls.find((entry) => entry.variable === 'fee');
  assert.ok(feeControl);
  assert.equal(feeControl.setters[0].scale, 1e12);
});

test('does not infer fee scales from arbitrary-valued constants with scale-like names', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Vault {
      uint256 public fee;
      uint256 public constant PRECISION = 12345;

      function setFee(uint256 value) external {
        fee = value;
      }
    }
  `);

  const feeControl = facts.feeControls.find((entry) => entry.variable === 'fee');
  assert.ok(feeControl);
  assert.equal(feeControl.setters[0].scale, null);
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

test('preserves exact cap values that exceed the safe integer range', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Vault {
      uint256 public fee;
      uint256 public constant MAX_FEE = 123456789123456789;

      function setFee(uint256 value) external {
        require(value <= MAX_FEE, "cap");
        fee = value / 10_000;
      }
    }
  `);

  const feeControl = facts.feeControls.find((entry) => entry.variable === 'fee');
  assert.ok(feeControl);
  assert.equal(feeControl.setters[0].capRaw, 'MAX_FEE');
  assert.equal(feeControl.setters[0].capValue, null);
  assert.equal(feeControl.setters[0].capValueExact, '123456789123456789');
});

test('extracts exclusive fee caps from require conditions', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Vault {
      uint256 public feeBps;
      uint256 public constant MAX_FEE_BPS = 1_000;

      function setFee(uint256 value) external {
        require(value < MAX_FEE_BPS, "cap");
        feeBps = value;
      }
    }
  `);

  const feeControl = facts.feeControls.find((entry) => entry.variable === 'feeBps');
  assert.ok(feeControl);
  assert.equal(feeControl.setters[0].capRaw, 'MAX_FEE_BPS');
  assert.equal(feeControl.setters[0].capValue, 999);
});

test('extracts fee caps from terminating if guards', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Vault {
      uint256 public feeBps;
      uint256 public constant MAX_FEE_BPS = 1_000;

      function setFee(uint256 value) external {
        if (value > MAX_FEE_BPS) {
          revert();
        }
        feeBps = value;
      }
    }
  `);

  const feeControl = facts.feeControls.find((entry) => entry.variable === 'feeBps');
  assert.ok(feeControl);
  assert.equal(feeControl.setters[0].capRaw, 'MAX_FEE_BPS');
  assert.equal(feeControl.setters[0].capValue, 1000);
});

test('extracts exclusive fee caps from terminating if guards', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Vault {
      uint256 public feeBps;
      uint256 public constant MAX_FEE_BPS = 1_000;

      function setFee(uint256 value) external {
        if (value >= MAX_FEE_BPS) {
          revert();
        }
        feeBps = value;
      }
    }
  `);

  const feeControl = facts.feeControls.find((entry) => entry.variable === 'feeBps');
  assert.ok(feeControl);
  assert.equal(feeControl.setters[0].capRaw, 'MAX_FEE_BPS');
  assert.equal(feeControl.setters[0].capValue, 999);
});

test('does not infer fee caps from non-terminating if branches', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Vault {
      event CapObserved(uint256 value);
      uint256 public feeBps;
      uint256 public constant MAX_FEE_BPS = 1_000;

      function setFee(uint256 value) external {
        if (value > MAX_FEE_BPS) {
          emit CapObserved(value);
        }
        feeBps = value;
      }
    }
  `);

  const feeControl = facts.feeControls.find((entry) => entry.variable === 'feeBps');
  assert.ok(feeControl);
  assert.equal(feeControl.setters[0].capRaw, null);
  assert.equal(feeControl.setters[0].capValue, null);
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
      function enableTrading() external {}
      function setBlacklist(address user, bool blocked) external { blacklist[user] = blocked; }
    }
  `);

  assert.ok(facts.tokenFeatures.mintFunctions.some((entry) => entry.function === 'mint'));
  assert.ok(facts.tokenFeatures.burnFunctions.some((entry) => entry.function === 'burn'));
  assert.ok(facts.tokenFeatures.transferHooks.some((entry) => entry.function === '_transfer'));
  assert.ok(facts.tokenFeatures.blacklistControls.length > 0);
  assert.ok(facts.tokenFeatures.tradingToggles.some((entry) => entry.name === 'tradingEnabled'));
  assert.ok(facts.tokenFeatures.maxLimits.some((entry) => entry.name === 'maxWallet'));
  assert.ok(facts.tokenFeatures.mintFunctions.some((entry) => entry.symbol === 'mint' && entry.origin === 'function'));
  assert.ok(facts.tokenFeatures.tradingToggles.some((entry) => entry.symbol === 'tradingEnabled' && entry.origin === 'variable'));
  assert.ok(facts.tokenFeatures.tradingToggles.some((entry) => entry.symbol === 'enableTrading' && entry.origin === 'function'));
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
  assert.ok(facts.tokenFeatures.feeOnTransferSignals.some((entry) => entry.function === 'transfer'));
});

test('does not infer pause guards from pause-like event names alone', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Vault {
      event PausedEvent();

      function withdraw(uint256 amount) external {
        emit PausedEvent();
      }
    }
  `);

  const exit = facts.userExitFunctions.find((entry) => entry.function === 'withdraw');
  assert.ok(exit);
  assert.equal(exit.gatedByPause, false);
  assert.deepEqual(exit.guardKinds, []);
});

test('infers guard kinds from standalone helper calls with guard-helper prefixes', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Vault {
      bool public paused;
      mapping(address => bool) public blacklist;
      bool public timelockActive;

      function withdraw(uint256 amount) external {
        _requireNotPaused();
      }

      function transfer(address to, uint256 amount) external returns (bool) {
        _checkBlacklist(msg.sender);
        return true;
      }

      function upgradeTo(address implementation) external {
        _enforceDelay();
      }

      function _requireNotPaused() internal view {
        require(!paused, "paused");
      }

      function _checkBlacklist(address user) internal view {
        require(!blacklist[user], "blocked");
      }

      function _enforceDelay() internal view {
        require(timelockActive, "delay");
      }
    }
  `);

  const exit = facts.userExitFunctions.find((entry) => entry.function === 'withdraw');
  assert.ok(exit);
  assert.equal(exit.gatedByPause, true);
  assert.ok(exit.guardKinds.includes('pause'));

  const transfer = facts.tokenFeatures.transferFunctions.find((entry) => entry.function === 'transfer');
  assert.ok(transfer);
  assert.equal(transfer.gatedByBlacklist, true);
  assert.ok(transfer.guardKinds.includes('blacklist'));

  const upgrade = facts.upgradePaths.find((entry) => entry.function === 'upgradeTo');
  assert.ok(upgrade);
  assert.equal(upgrade.hasVisibleTimelock, true);
});

test('infers guard kinds from member-access helper calls with guard-helper prefixes', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;

    library GuardLib {
      function _requireNotPaused(bool paused) internal pure {
        require(!paused, "paused");
      }

      function _checkBlacklist(bool blocked) internal pure {
        require(!blocked, "blocked");
      }

      function _enforceDelay(bool delayActive) internal pure {
        require(delayActive, "delay");
      }

      function pauseAndBurn() internal pure {}
    }

    contract Vault {
      bool public paused;
      mapping(address => bool) public blacklist;
      bool public timelockActive;

      function withdraw(uint256 amount) external {
        GuardLib._requireNotPaused(paused);
      }

      function transfer(address to, uint256 amount) external returns (bool) {
        GuardLib._checkBlacklist(blacklist[msg.sender]);
        return true;
      }

      function upgradeTo(address implementation) external {
        GuardLib._enforceDelay(timelockActive);
      }

      function claim(uint256 amount) external {
        GuardLib.pauseAndBurn();
      }
    }
  `);

  const withdraw = facts.userExitFunctions.find((entry) => entry.function === 'withdraw');
  assert.ok(withdraw);
  assert.equal(withdraw.gatedByPause, true);
  assert.ok(withdraw.guardKinds.includes('pause'));

  const transfer = facts.tokenFeatures.transferFunctions.find((entry) => entry.function === 'transfer');
  assert.ok(transfer);
  assert.equal(transfer.gatedByBlacklist, true);
  assert.ok(transfer.guardKinds.includes('blacklist'));

  const upgrade = facts.upgradePaths.find((entry) => entry.function === 'upgradeTo');
  assert.ok(upgrade);
  assert.equal(upgrade.hasVisibleTimelock, true);

  const claim = facts.userExitFunctions.find((entry) => entry.function === 'claim');
  assert.ok(claim);
  assert.deepEqual(claim.guardKinds, []);
});

test('does not infer guard kinds from bare action calls with pause-like names', () => {
  const facts = compileFacts(`
    pragma solidity 0.8.20;
    contract Vault {
      function withdraw(uint256 amount) external {
        pauseAndBurn();
      }

      function pauseAndBurn() internal {}
    }
  `);

  const exit = facts.userExitFunctions.find((entry) => entry.function === 'withdraw');
  assert.ok(exit);
  assert.deepEqual(exit.guardKinds, []);
});

test('booleanLiteralValue accepts string and boolean AST values', () => {
  assert.equal(__internal.booleanLiteralValue({ nodeType: 'Literal', kind: 'bool', value: 'true' }), true);
  assert.equal(__internal.booleanLiteralValue({ nodeType: 'Literal', kind: 'bool', value: 'false' }), false);
  assert.equal(__internal.booleanLiteralValue({ nodeType: 'Literal', kind: 'bool', value: true }), true);
  assert.equal(__internal.booleanLiteralValue({ nodeType: 'Literal', kind: 'bool', value: false }), false);
  assert.equal(__internal.booleanLiteralValue({ nodeType: 'Literal', kind: 'number', value: '1' }), null);
});

test('literalValue parses exact integer literals without precision loss', () => {
  assert.equal(
    __internal.literalValue({ nodeType: 'Literal', kind: 'number', value: '123456789123456789' }),
    123456789123456789n,
  );
  assert.equal(
    __internal.literalValue({ nodeType: 'Literal', kind: 'number', value: '1e18' }),
    1000000000000000000n,
  );
  assert.equal(
    __internal.literalValue({ nodeType: 'Literal', kind: 'number', value: '0x10' }),
    16n,
  );
});
