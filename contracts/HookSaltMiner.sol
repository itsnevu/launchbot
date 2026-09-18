// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
interface IPortal { function predict(address,bytes32,bytes32,uint16,uint16,address) external view returns (address,uint256,bool); }
contract Miner {
    function mine(address portal, address creator, bytes32 tokenSalt, bytes32 start, uint16 buy, uint16 sell, address quote, uint256 n)
        external view returns (bytes32 salt, address hook, bool found, uint256 tried)
    {
        uint256 s = uint256(start);
        for (uint256 i = 0; i < n; i++) {
            (bool ok, bytes memory ret) = portal.staticcall(abi.encodeWithSelector(0x3ae04f1d, creator, tokenSalt, bytes32(s + i), buy, sell, quote));
            if (ok && ret.length >= 96) {
                (address h,, bool v) = abi.decode(ret, (address, uint256, bool));
                if (v) return (bytes32(s + i), h, true, i + 1);
            }
        }
        return (bytes32(0), address(0), false, n);
    }
}
