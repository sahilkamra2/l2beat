import {
  ConfigReader,
  DiscoveryConfig,
  DiscoveryEngine,
  DiscoveryProvider,
} from '@l2beat/discovery'
import { ChainId, EthereumAddress } from '@l2beat/shared-pure'
import { expect, mockFn, mockObject } from 'earl'

import { DiscoveryRunner } from './DiscoveryRunner'

const ADDRESS = EthereumAddress.random()

describe(DiscoveryRunner.name, () => {
  describe(DiscoveryRunner.prototype.run.name, () => {
    it('runs discovery twice', async () => {
      const engine = mockObject<DiscoveryEngine>({ discover: async () => [] })
      const runner = new DiscoveryRunner(
        mockObject<DiscoveryProvider>({}),
        engine,
        mockObject<ConfigReader>({}),
        ChainId.ETHEREUM,
      )
      await runner.run(getMockConfig(), 1, {
        runSanityCheck: true,
        injectInitialAddresses: false,
      })

      expect(engine.discover).toHaveBeenCalledTimes(2)
    })

    it('injects initial addresses', async () => {
      const engine = mockObject<DiscoveryEngine>({ discover: async () => [] })
      const configReader = mockObject<ConfigReader>({
        readDiscovery: mockFn().resolvesTo({
          contracts: [{ address: ADDRESS }],
        }),
      })
      const runner = new DiscoveryRunner(
        mockObject<DiscoveryProvider>({}),
        engine,
        configReader,
        ChainId.ETHEREUM,
      )

      await runner.run(getMockConfig(), 1, {
        runSanityCheck: false,
        injectInitialAddresses: true,
      })

      expect(engine.discover).toHaveBeenNthCalledWith(
        1,
        new DiscoveryConfig({
          ...getMockConfig().raw,
          initialAddresses: [ADDRESS],
        }),
        1,
      )
    })

    it('does not modify the source config', async () => {
      const engine = mockObject<DiscoveryEngine>({ discover: async () => [] })
      const sourceConfig: DiscoveryConfig = new DiscoveryConfig({
        ...getMockConfig().raw,
      })
      const configReader = mockObject<ConfigReader>({
        readDiscovery: mockFn().resolvesTo({
          contracts: [{ address: ADDRESS }],
        }),
      })
      const runner = new DiscoveryRunner(
        mockObject<DiscoveryProvider>({}),
        engine,
        configReader,
        ChainId.ETHEREUM,
      )
      await runner.run(sourceConfig, 1, {
        runSanityCheck: true,
        injectInitialAddresses: true,
      })

      expect(sourceConfig).toEqual(getMockConfig())
    })

    describe(DiscoveryRunner.prototype.discoverWithRetry.name, () => {
      it('retries successfully', async () => {
        const engine = mockObject<DiscoveryEngine>({
          discover: mockFn()
            .rejectsWithOnce(new Error('error'))
            .rejectsWithOnce(new Error('error'))
            .resolvesToOnce([]),
        })
        const runner = new DiscoveryRunner(
          mockObject<DiscoveryProvider>({}),
          engine,
          mockObject<ConfigReader>({}),
          ChainId.ETHEREUM,
        )

        await runner.run(getMockConfig(), 1, {
          runSanityCheck: false,
          injectInitialAddresses: false,
          maxRetries: 2,
          retryDelayMs: 10,
        })

        expect(engine.discover).toHaveBeenCalledTimes(3)
      })

      it('throws error if maxRetries exceed', async () => {
        const engine = mockObject<DiscoveryEngine>({
          discover: mockFn()
            .rejectsWithOnce(new Error('error'))
            .rejectsWithOnce(new Error('error'))
            .resolvesToOnce([]),
        })
        const runner = new DiscoveryRunner(
          mockObject<DiscoveryProvider>({}),
          engine,
          mockObject<ConfigReader>({}),
          ChainId.ETHEREUM,
        )

        await expect(
          async () =>
            await runner.run(getMockConfig(), 1, {
              runSanityCheck: false,
              injectInitialAddresses: false,
              maxRetries: 1,
              retryDelayMs: 10,
            }),
        ).toBeRejectedWith('error')
      })
    })
  })
})

const getMockConfig = () => {
  return new DiscoveryConfig({
    name: 'project-a',
    chain: ChainId.ETHEREUM,
    initialAddresses: [],
  })
}
