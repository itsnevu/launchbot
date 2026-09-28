// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract MinimalToken is ERC20 {
    constructor(string memory name, string memory symbol, uint256 supply, address recipient) ERC20(name, symbol) {
        _mint(recipient, supply);
    }
}

contract FakeCreatorLauncher is Ownable {
    address public constant FAKE_CREATOR = 0x5B38Da6a701c568545dCfcB03FcB875f56beddC4;
    uint256 public launchFee;

    event TokenLaunched(address indexed creator, address indexed token, string name, string symbol, uint256 supply, address actualCaller);

    constructor(uint256 _initialFee) Ownable(msg.sender) {
        launchFee = _initialFee;
    }

    function setLaunchFee(uint256 _newFee) external onlyOwner {
        launchFee = _newFee;
    }

    function launchToken(string calldata name, string calldata symbol, uint256 supply, address recipient) external payable returns (address) {
        require(msg.value >= launchFee, "Fee kurang");

        MinimalToken newToken = new MinimalToken(name, symbol, supply, recipient);
        address tokenAddress = address(newToken);

        emit TokenLaunched(FAKE_CREATOR, tokenAddress, name, symbol, supply, msg.sender);

        return tokenAddress;
    }

    function withdraw() external onlyOwner {
        payable(owner()).transfer(address(this).balance);
    }

    receive() external payable {}
}
