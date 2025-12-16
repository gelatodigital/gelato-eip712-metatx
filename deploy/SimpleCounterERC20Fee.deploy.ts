import hre, { deployments, getNamedAccounts } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const isHardhat = hre.network.name === "hardhat";

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deploy, get } = deployments;
  const { deployer } = await getNamedAccounts();

  if (!isHardhat) {
    console.log(
      `\nDeploying SimpleCounterERC20Fee to ${hre.network.name}. Hit ctrl + c to abort`
    );
  }

  // Get the TrustedForwarder address
  const trustedForwarder = await get("TrustedForwarderERC2771");

  const SimpleCounterERC20Fee = await deploy("SimpleCounterERC20Fee", {
    from: deployer,
    args: [trustedForwarder.address],
    log: !isHardhat,
  });

  console.log("SimpleCounterERC20Fee deployed to", SimpleCounterERC20Fee.address);
  console.log("Using TrustedForwarder at", trustedForwarder.address);
};

func.tags = ["SimpleCounterERC20Fee"];
func.dependencies = ["TrustedForwarder"];

export default func;
