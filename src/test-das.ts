
import "dotenv/config";

async function testDas() {
    const HELIUS_KEY = process.env.HELIUS_API_KEY;
    const wallet = "5Gan5qxGeqmg4RLDLfgLLcGKKS1Ppy1hhsKV1WBr2Xjh";
    const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

    const dasRes = await fetch(heliusUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'test-das',
            method: 'getAssetsByOwner',
            params: {
                ownerAddress: wallet,
                page: 1,
                limit: 1000,
                displayOptions: {
                    showFungible: true,
                    showNativeBalance: true
                }
            }
        })
    });

    const dasData = await dasRes.json() as any;
    console.log(JSON.stringify(dasData, null, 2));
}

testDas();
