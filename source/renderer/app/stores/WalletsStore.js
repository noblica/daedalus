// @flow
import { observable, action, computed, runInAction, flow } from 'mobx';
import { get, find, findIndex, isEqual, includes } from 'lodash';
import { BigNumber } from 'bignumber.js';
import Store from './lib/Store';
import Request from './lib/LocalizedRequest';
import Wallet, { WalletSyncStateStatuses } from '../domains/Wallet';
import WalletAddress from '../domains/WalletAddress';
import { WalletTransaction } from '../domains/WalletTransaction';
import { MAX_ADA_WALLETS_COUNT } from '../config/numbersConfig';
import { i18nContext } from '../utils/i18nContext';
import { mnemonicToSeedHex, getScrambledInput } from '../utils/crypto';
import { paperWalletPdfGenerator } from '../utils/paperWalletPdfGenerator';
import { addressPDFGenerator } from '../utils/addressPDFGenerator';
import { downloadCsv } from '../utils/csvGenerator';
import { buildRoute, matchRoute } from '../utils/routing';
import { logger } from '../utils/logging';
import { ROUTES } from '../routes-config';
import { formattedWalletAmount } from '../utils/formatters';
import { ellipsis } from '../utils/strings';
import { bech32EncodePublicKey } from '../utils/hardwareWalletUtils';
import {
  WalletPaperWalletOpenPdfError,
  WalletRewardsOpenCsvError,
} from '../i18n/errors';
import {
  WALLET_KINDS,
  WALLET_DAEDALUS_KINDS,
  WALLET_YOROI_KINDS,
  WALLET_HARDWARE_KINDS,
  RESTORE_WALLET_STEPS,
} from '../config/walletRestoreConfig';
import { IS_WALLET_PUBLIC_KEY_SHARING_ENABLED } from '../config/walletsConfig';
import {
  CURRENCY_REQUEST_RATE_INTERVAL,
  getLocalizedCurrency,
  getLocalizedCurrenciesList,
  getCurrencyFromCode,
} from '../config/currencyConfig';
import type {
  WalletKind,
  WalletDaedalusKind,
  WalletYoroiKind,
  WalletHardwareKind,
} from '../types/walletRestoreTypes';
import type { Currency, LocalizedCurrency } from '../types/currencyTypes.js';
import type { CsvFileContent } from '../../../common/types/csv-request.types';
import type { WalletExportTypeChoices } from '../types/walletExportTypes';
import type { WalletImportFromFileParams } from '../actions/wallets-actions';
import type LocalizableError from '../i18n/LocalizableError';
import type {
  TransferFundsCalculateFeeRequest,
  TransferFundsRequest,
} from '../api/wallets/types';
import type { QuitStakePoolRequest } from '../api/staking/types';
import type {
  TransportDevice,
  HardwareWalletExtendedPublicKeyResponse,
} from '../../../common/types/hardware-wallets.types';
import { introspectAddressChannel } from '../ipc/introspect-address';
import { saveQRCodeImageChannel } from '../ipc/saveQRCodeImageChannel';
import type { AddressStyle } from '../../../common/types/address-introspection.types';
import {
  TESTNET_MAGIC,
  SELFNODE_MAGIC,
  STAGING_MAGIC,
  SHELLEY_TESTNET_NETWORK_ID,
  ITN_MAGIC,
  MAINNET_MAGIC,
} from '../../../common/types/cardano-node.types';
import type { WalletSummaryAsset } from '../api/assets/types';

/* eslint-disable consistent-return */

/**
 * The base wallet store that contains logic for dealing with wallets
 */

export default class WalletsStore extends Store {
  WALLET_REFRESH_INTERVAL = 5000;

  @observable undelegateWalletSubmissionSuccess: ?boolean = null;

  @observable isAddressFromSameWallet: boolean = false;

  // REQUESTS
  @observable walletsRequest: Request<Array<Wallet>> = new Request(
    this.api.ada.getWallets
  );
  @observable accountPublicKeyRequest: Request<string> = new Request(
    this.api.ada.getAccountPublicKey
  );
  @observable importFromFileRequest: Request<Wallet> = new Request(
    this.api.ada.importWalletFromFile
  );
  @observable createWalletRequest: Request<Wallet> = new Request(
    this.api.ada.createWallet
  );
  @observable
  getWalletAddressesRequest: Request<Array<WalletAddress>> = new Request(
    this.api.ada.getAddresses
  );
  @observable deleteWalletRequest: Request<boolean> = new Request(
    this.api.ada.deleteWallet
  );
  @observable sendMoneyRequest: Request<WalletTransaction> = new Request(
    this.api.ada.createTransaction
  );
  @observable getWalletRecoveryPhraseRequest: Request<
    Array<string>
  > = new Request(this.api.ada.getWalletRecoveryPhrase);
  @observable getWalletCertificateAdditionalMnemonicsRequest: Request<
    Array<string>
  > = new Request(this.api.ada.getWalletCertificateAdditionalMnemonics);
  @observable getWalletCertificateRecoveryPhraseRequest: Request<
    Array<string>
  > = new Request(this.api.ada.getWalletCertificateRecoveryPhrase);
  @observable getWalletRecoveryPhraseFromCertificateRequest: Request<
    Array<string>
  > = new Request(this.api.ada.getWalletRecoveryPhraseFromCertificate);
  @observable restoreDaedalusRequest: Request<Wallet> = new Request(
    this.api.ada.restoreWallet
  );
  @observable restoreLegacyRequest: Request<Wallet> = new Request(
    this.api.ada.restoreLegacyWallet
  );
  @observable restoreByronRandomWalletRequest: Request<Wallet> = new Request(
    this.api.ada.restoreByronRandomWallet
  );
  @observable restoreByronIcarusWalletRequest: Request<Wallet> = new Request(
    this.api.ada.restoreByronIcarusWallet
  );
  @observable restoreByronTrezorWalletRequest: Request<Wallet> = new Request(
    this.api.ada.restoreByronTrezorWallet
  );
  @observable restoreByronLedgerWalletRequest: Request<Wallet> = new Request(
    this.api.ada.restoreByronLedgerWallet
  );
  @observable
  transferFundsCalculateFeeRequest: Request<TransferFundsCalculateFeeRequest> = new Request(
    this.api.ada.transferFundsCalculateFee
  );
  @observable transferFundsRequest: Request<TransferFundsRequest> = new Request(
    this.api.ada.transferFunds
  );
  @observable createHardwareWalletRequest: Request<Wallet> = new Request(
    this.api.ada.createHardwareWallet
  );

  /* ----------  Active Wallet  ---------- */
  @observable active: ?Wallet = null;
  @observable activeValue: ?BigNumber = null;
  @observable activePublicKey: ?string = null;

  /* ------------  Currencies  ----------- */
  @observable currencyIsFetchingList: boolean = false;
  @observable currencyIsFetchingRate: boolean = false;
  @observable currencyIsAvailable: boolean = false;
  @observable currencyIsActive: boolean = false;
  @observable currencyList: Array<Currency> = [];
  @observable currencySelected: ?Currency = null;
  @observable currencyRate: ?number = null;
  @observable currencyLastFetched: ?Date = null;

  /* ----------  Create Wallet  ---------- */
  @observable createWalletStep = null;
  @observable createWalletShowAbortConfirmation = false;
  // TODO: Remove once the new wallet creation process is ready
  @observable createWalletUseNewProcess = false;

  /* ----------  Restore Wallet  ---------- */
  @observable restoreWalletStep = null;
  @observable restoreWalletShowAbortConfirmation = false;
  // STEP: WALLET TYPE
  @observable walletKind: ?WalletKind = null;
  @observable walletKindDaedalus: ?WalletDaedalusKind = null;
  @observable walletKindYoroi: ?WalletYoroiKind = null;
  @observable walletKindHardware: ?WalletHardwareKind = null;
  // STEP: RECOVERY PHRASE
  @observable mnemonics: Array<string> = [];
  // STEP: CONFIGURATION
  @observable walletName: string = '';
  @observable spendingPassword: string = '';
  @observable repeatPassword: string = '';
  // TODO: Remove once the new restore creation process is ready
  @observable restoreWalletUseNewProcess = true;
  @observable restoredWallet: ?Wallet = null;

  /* ----------  Export Wallet  ---------- */
  @observable walletExportType: WalletExportTypeChoices = 'paperWallet';
  @observable walletExportMnemonic =
    'marine joke dry silk ticket thing sugar stereo aim';

  /* ----------  Delete Wallet  ---------- */
  @observable isDeleting: boolean = false;

  /* ----------  Paper Wallet  ---------- */
  @observable createPaperWalletCertificateStep = 0;
  @observable walletCertificatePassword = null;
  @observable walletCertificateAddress = null;
  @observable walletCertificateRecoveryPhrase = null;
  @observable generatingCertificateInProgress = false;
  @observable generatingCertificateError: ?LocalizableError = null;
  @observable generatingRewardsCsvInProgress = false;
  @observable generatingRewardsCsvError: ?LocalizableError = null;
  @observable certificateStep = null;
  @observable certificateTemplate = null;
  @observable additionalMnemonicWords = null;

  /* ----------  Transfer Funds  ---------- */
  @observable transferFundsSourceWalletId: string = '';
  @observable transferFundsTargetWalletId: string = '';
  @observable transferFundsStep: number = 0;
  @observable transferFundsFee: ?BigNumber = null;
  @observable transferFundsLeftovers: ?BigNumber = null;

  /* ----------  Other  ---------- */

  _newWalletDetails: {
    name: string,
    mnemonic: string,
    spendingPassword: string,
  } = {
    name: '',
    mnemonic: '',
    spendingPassword: '',
  };
  _pollingBlocked = false;
  _getCurrencyRateInterval: ?IntervalID = null;

  setup() {
    setInterval(this._pollRefresh, this.WALLET_REFRESH_INTERVAL);

    this.registerReactions([this._updateActiveWalletOnRouteChanges]);

    const {
      router,
      walletBackup,
      wallets: walletsActions,
      app,
      networkStatus,
    } = this.actions;

    // Create Wallet Actions ---
    walletsActions.createWallet.listen(this._create);
    walletsActions.createWalletBegin.listen(this._createWalletBegin);
    walletsActions.createWalletChangeStep.listen(this._createWalletChangeStep);
    walletsActions.createWalletAbort.listen(this._createWalletAbort);
    walletsActions.createWalletClose.listen(this._createWalletClose);
    walletsActions.createHardwareWallet.listen(this._createHardwareWallet);
    // ---
    // Restore Wallet Actions ---
    walletsActions.restoreWallet.listen(this._restore);
    walletsActions.restoreWalletBegin.listen(this._restoreWalletBegin);
    walletsActions.restoreWalletEnd.listen(this._restoreWalletEnd);
    walletsActions.restoreWalletChangeStep.listen(
      this._restoreWalletChangeStep
    );
    walletsActions.restoreWalletClose.listen(this._restoreWalletClose);
    walletsActions.restoreWalletCancelClose.listen(
      this._restoreWalletCancelClose
    );
    walletsActions.restoreWalletSetKind.listen(this._restoreWalletSetKind);
    walletsActions.restoreWalletSetMnemonics.listen(
      this._restoreWalletSetMnemonics
    );
    walletsActions.restoreWalletSetConfig.listen(this._restoreWalletSetConfig);
    walletsActions.deleteWallet.listen(this._deleteWallet);
    walletsActions.undelegateWallet.listen(this._undelegateWallet);
    walletsActions.setUndelegateWalletSubmissionSuccess.listen(
      this._setUndelegateWalletSubmissionSuccess
    );
    walletsActions.sendMoney.listen(this._sendMoney);
    walletsActions.importWalletFromFile.listen(this._importWalletFromFile);
    walletsActions.chooseWalletExportType.listen(this._chooseWalletExportType);
    walletsActions.getAccountPublicKey.listen(this._getAccountPublicKey);

    walletsActions.generateCertificate.listen(this._generateCertificate);
    walletsActions.generateAddressPDF.listen(this._generateAddressPDF);
    walletsActions.saveQRCodeImage.listen(this._saveQRCodeImage);
    walletsActions.updateCertificateStep.listen(this._updateCertificateStep);
    walletsActions.closeCertificateGeneration.listen(
      this._closeCertificateGeneration
    );

    walletsActions.generateCsv.listen(this._generateCsv);
    walletsActions.closeRewardsCsvGeneration.listen(
      this._closeRewardsCsvGeneration
    );

    walletsActions.setCertificateTemplate.listen(this._setCertificateTemplate);
    walletsActions.finishCertificate.listen(this._finishCertificate);
    walletsActions.finishRewardsCsv.listen(this._finishRewardsCsv);
    router.goToRoute.listen(this._onRouteChange);
    walletBackup.finishWalletBackup.listen(this._finishWalletBackup);
    app.initAppEnvironment.listen(() => {});
    networkStatus.restartNode.listen(this._updateGeneratingCertificateError);
    networkStatus.restartNode.listen(this._updateGeneratingRewardsCsvError);
    walletsActions.transferFundsNextStep.listen(this._transferFundsNextStep);
    walletsActions.transferFundsPrevStep.listen(this._transferFundsPrevStep);
    walletsActions.transferFunds.listen(this._transferFunds);
    walletsActions.transferFundsSetSourceWalletId.listen(
      this._transferFundsSetSourceWalletId
    );
    walletsActions.transferFundsSetTargetWalletId.listen(
      this._transferFundsSetTargetWalletId
    );
    walletsActions.transferFundsRedeem.listen(this._transferFundsRedeem);
    walletsActions.transferFundsClose.listen(this._transferFundsClose);
    walletsActions.transferFundsCalculateFee.listen(
      this._transferFundsCalculateFee
    );
    walletsActions.setCurrencySelected.listen(this._setCurrencySelected);
    walletsActions.toggleCurrencyIsActive.listen(this._toggleCurrencyIsActive);

    this.setupCurrency();
  }

  @action _getAccountPublicKey = async ({
    spendingPassword: passphrase,
  }: {
    spendingPassword: string,
  }) => {
    if (!this.active || !IS_WALLET_PUBLIC_KEY_SHARING_ENABLED) {
      return;
    }

    const walletId = this.active.id;
    const index = '0H';
    const extended = true;

    try {
      const accountPublicKey = await this.accountPublicKeyRequest.execute({
        walletId,
        index,
        passphrase,
        extended,
      }).promise;
      runInAction('update account public key', () => {
        this.activePublicKey = accountPublicKey;
      });
    } catch (error) {
      throw error;
    }
  };

  @action setupCurrency = async () => {
    // CURRENCY_REQUEST_RATE_INTERVAL

    // Check if the user has enabled currencies
    // Otherwise applies the default config
    const currencyIsActive = await this.api.localStorage.getCurrencyIsActive();

    // Check if the user has already selected a currency
    // Otherwise applies the default currency
    const localCurrencyCode = await this.api.localStorage.getCurrencySelected();
    const currencySelected = getCurrencyFromCode(localCurrencyCode);

    runInAction(() => {
      this.currencyIsActive = currencyIsActive;
      this.currencySelected = currencySelected;
    });

    clearInterval(this._getCurrencyRateInterval);
    this._getCurrencyRateInterval = setInterval(
      this.getCurrencyRate,
      CURRENCY_REQUEST_RATE_INTERVAL
    );

    // Fetch the currency list and rate
    this.getCurrencyList();
    this.getCurrencyRate();
  };

  @action getCurrencyList = async () => {
    this.currencyIsFetchingList = true;
    const currencyList = await this.api.ada.getCurrencyList();
    runInAction(() => {
      this.currencyList = currencyList;
      this.currencyIsFetchingList = false;
    });
  };

  @action getCurrencyRate = async () => {
    const { localizedCurrency } = this;
    if (localizedCurrency && localizedCurrency.code) {
      try {
        this.currencyIsFetchingRate = true;
        const currencyRate = await this.api.ada.getCurrencyRate(
          localizedCurrency
        );
        runInAction(() => {
          this.currencyIsFetchingRate = false;
          this.currencyLastFetched = new Date();
          if (currencyRate) {
            this.currencyRate = currencyRate;
            this.currencyIsAvailable = true;
          } else {
            throw new Error('Error fetching the Currency rate');
          }
        });
      } catch (error) {
        runInAction(() => {
          this.currencyRate = null;
          this.currencyIsAvailable = false;
        });
        clearInterval(this._getCurrencyRateInterval);
      }
    }
  };

  @action _setCurrencySelected = async ({
    currencyCode,
  }: {
    currencyCode: string,
  }) => {
    const { currencyList } = this;
    const currencySelected = currencyList.find(
      ({ code }) => currencyCode === code
    );
    if (currencySelected) {
      this.currencySelected = currencySelected;
      this.getCurrencyRate();
      await this.api.localStorage.setCurrencySelected(currencySelected.code);
    }
  };

  @action _toggleCurrencyIsActive = () => {
    this.currencyIsActive = !this.currencyIsActive;
    this.api.localStorage.setCurrencyIsActive(this.currencyIsActive);
  };

  _create = async (params: { name: string, spendingPassword: string }) => {
    Object.assign(this._newWalletDetails, params);
    try {
      const recoveryPhrase: ?Array<string> = await this.getWalletRecoveryPhraseRequest.execute()
        .promise;
      if (recoveryPhrase != null) {
        this.actions.walletBackup.initiateWalletBackup.trigger({
          recoveryPhrase,
        });
      }
    } catch (error) {
      throw error;
    }
  };

  // TODO: Remove once the new wallet creation process is ready
  @action _togglecreateWalletUseNewProcess = () => {
    this.createWalletUseNewProcess = !this.createWalletUseNewProcess;
  };

  @action _createWalletBegin = () => {
    this.createWalletStep = 0;
    this.createWalletShowAbortConfirmation = false;
  };

  @action _createWalletChangeStep = (isBack: boolean = false) => {
    const currrentCreateWalletStep = this.createWalletStep || 0;
    this.createWalletStep =
      isBack === true
        ? currrentCreateWalletStep - 1
        : currrentCreateWalletStep + 1;
    this.createWalletShowAbortConfirmation = false;
  };

  @action _createWalletClose = () => {
    this.createWalletStep = null;
    this.createWalletShowAbortConfirmation = false;
  };

  @action _createWalletAbort = () => {
    this.createWalletShowAbortConfirmation = true;
  };

  @action _restoreWalletBegin = () => {
    this.restoreWalletStep = 0;
    this.restoreWalletShowAbortConfirmation = false;
  };

  @action _restoreWalletEnd = async () => {
    this._resumePolling();
    const { restoredWallet } = this;
    if (restoredWallet) {
      await this._patchWalletRequestWithNewWallet(restoredWallet);
      this.goToWalletRoute(restoredWallet.id);
      this.refreshWalletsData();
      this._restoreWalletResetRequests();
      this._restoreWalletResetData();
    }
  };

  @action _restoreWalletChangeStep = (isBack: boolean = false) => {
    // Reset restore requests to clear previous errors
    const currrentRestoreWalletStep = this.restoreWalletStep || 0;
    this._restoreWalletResetRequests();
    if (this.restoreWalletStep === null) {
      this._restoreWalletResetData();
    }
    this.restoreWalletStep =
      isBack === true
        ? currrentRestoreWalletStep - 1
        : currrentRestoreWalletStep + 1;
    this.restoreWalletShowAbortConfirmation = false;
  };

  @action _restoreWalletClose = () => {
    const { mnemonics, walletName, spendingPassword } = this;
    const shouldDisplayAbortAlert =
      (mnemonics.length || walletName.length || spendingPassword.length) &&
      this.restoreWalletStep !== null &&
      this.restoreWalletStep < RESTORE_WALLET_STEPS.length - 1;
    if (shouldDisplayAbortAlert && !this.restoreWalletShowAbortConfirmation) {
      this.restoreWalletShowAbortConfirmation = true;
    } else {
      this._restoreWalletResetRequests();
      this._restoreWalletResetData();
      this.actions.dialogs.closeActiveDialog.trigger();
    }
  };

  @action _restoreWalletCancelClose = () => {
    this.restoreWalletShowAbortConfirmation = false;
  };

  _restoreWalletResetRequests = () => {
    this.restoreDaedalusRequest.reset();
    this.restoreByronIcarusWalletRequest.reset();
    this.restoreByronLedgerWalletRequest.reset();
    this.restoreByronRandomWalletRequest.reset();
    this.restoreByronTrezorWalletRequest.reset();
    this.getWalletRecoveryPhraseFromCertificateRequest.reset();
  };

  @action _restoreWalletResetData = () => {
    this.restoreWalletStep = null;
    this.restoreWalletShowAbortConfirmation = false;
    this.restoredWallet = null;
    this.walletKind = null;
    this.walletKindDaedalus = null;
    this.walletKindYoroi = null;
    this.walletKindHardware = null;
    this.mnemonics = [];
    this.walletName = '';
    this.spendingPassword = '';
    this.repeatPassword = '';
  };

  @action _restoreWalletSetKind = ({
    param,
    kind,
  }: {
    param?: string,
    kind: string,
  }) => {
    (this: any)[`walletKind${param || ''}`] = kind;
    this.mnemonics = [];
  };

  @action _restoreWalletSetMnemonics = ({
    mnemonics,
  }: {
    mnemonics: Array<string>,
  }) => {
    this.mnemonics = mnemonics;
  };

  @action _restoreWalletSetConfig = ({
    param,
    value,
  }: {
    param: string,
    value: string,
  }) => {
    if (param === 'walletName') {
      this.walletName = value;
    } else if (param === 'spendingPassword') {
      this.spendingPassword = value;
    } else if (param === 'repeatPassword') {
      this.repeatPassword = value;
    }
  };

  @action _createHardwareWallet = async (params: {
    walletName: string,
    extendedPublicKey: HardwareWalletExtendedPublicKeyResponse,
    device: TransportDevice,
  }) => {
    const { walletName, extendedPublicKey, device } = params;
    const { deviceId, deviceType, deviceModel, deviceName, path } = device;
    const accountPublicKey =
      extendedPublicKey.publicKeyHex + extendedPublicKey.chainCodeHex;

    logger.debug('[HW-DEBUG] HWStore - Execute HW create / restore', {
      deviceId,
      deviceType,
      deviceModel,
      deviceName,
      path,
      walletName,
    });

    try {
      await this._pausePolling();
      const wallet = await this.createHardwareWalletRequest.execute({
        walletName,
        accountPublicKey,
      });
      await this.stores.hardwareWallets._setHardwareWalletLocalData({
        walletId: wallet.id,
        data: {
          device,
          extendedPublicKey,
          disconnected: false,
        },
      });

      await this.stores.hardwareWallets._setHardwareWalletDevice({
        deviceId,
        data: {
          deviceType,
          deviceModel,
          deviceName,
          path,
          paired: wallet.id, // device paired with software wallet
          disconnected: false, // device physically disconnected
        },
      });

      if (wallet) {
        await this._patchWalletRequestWithNewWallet(wallet);
        this.goToWalletRoute(wallet.id);
        this.refreshWalletsData();
        this.actions.dialogs.closeActiveDialog.trigger();
      }
    } catch (error) {
      throw error;
    } finally {
      this._resumePolling();
    }
  };

  _finishWalletBackup = async () => {
    this._newWalletDetails.mnemonic = this.stores.walletBackup.recoveryPhrase.join(
      ' '
    );
    const wallet = await this.createWalletRequest.execute(
      this._newWalletDetails
    ).promise;
    if (wallet) {
      await this._patchWalletRequestWithNewWallet(wallet);
      this.actions.dialogs.closeActiveDialog.trigger();
      this.goToWalletRoute(wallet.id);
      this.refreshWalletsData();
    }
  };

  _deleteWallet = async (params: { walletId: string, isLegacy: boolean }) => {
    // Pause polling in order to avoid fetching data for wallet we are about to delete
    runInAction('AdaWalletsStore::isDeleting set', () => {
      this.isDeleting = true;
    });
    await this._pausePolling();
    const walletToDelete = this.getWalletById(params.walletId);
    if (!walletToDelete) {
      runInAction('AdaWalletsStore::isDeleting reset', () => {
        this.isDeleting = false;
      });
      return;
    }
    const indexOfWalletToDelete = this.all.indexOf(walletToDelete);
    await this.deleteWalletRequest.execute({
      walletId: params.walletId,
      isLegacy: params.isLegacy || false,
    });
    await this.walletsRequest.patch((result) => {
      result.splice(indexOfWalletToDelete, 1);
    });

    runInAction('AdaWalletsStore::_deleteWallet', () => {
      this.isDeleting = false;
      if (this.hasAnyWallets) {
        const nextIndexInList = Math.max(indexOfWalletToDelete - 1, 0);
        const nextWalletInList = this.all[nextIndexInList];
        this.goToWalletRoute(nextWalletInList.id);
      } else {
        this.active = null;
        this.activeValue = null;
        this.actions.router.goToRoute.trigger({
          route: ROUTES.WALLETS.ADD,
        });
      }
    });
    this.actions.dialogs.closeActiveDialog.trigger();
    this.actions.walletsLocal.unsetWalletLocalData.trigger({
      walletId: params.walletId,
    });
    await this.stores.hardwareWallets._unsetHardwareWalletLocalData({
      walletId: params.walletId,
    });
    this._resumePolling();
    this.deleteWalletRequest.reset();
    this.refreshWalletsData();
  };

  _undelegateWallet = async (params: QuitStakePoolRequest) => {
    const { quitStakePoolRequest } = this.stores.staking;
    const { quitStakePool } = this.actions.staking;
    const walletToUndelegate = this.getWalletById(params.walletId);
    if (!walletToUndelegate) {
      return;
    }
    await quitStakePool.trigger(params);
    this._setUndelegateWalletSubmissionSuccess({ result: true });
    quitStakePoolRequest.reset();
    this.refreshWalletsData();
  };

  _setUndelegateWalletSubmissionSuccess = ({ result }: { result: boolean }) => {
    runInAction(
      'AdaWalletsStore::_setUndelegateWalletSubmissionSuccess',
      () => {
        this.undelegateWalletSubmissionSuccess = result;
      }
    );
  };

  _getUnscrambledMnemonics = async (
    mnemonics: Array<string>
  ): Array<string> => {
    // Split recovery phrase to 18 (scrambled mnemonics) + 9 (mnemonics seed) mnemonics
    const { passphrase, scrambledInput } = getScrambledInput(mnemonics);

    // Unscramble 18-word wallet certificate mnemonic to 12-word mnemonic
    const unscrambledRecoveryPhrase: Array<string> = await this.getWalletRecoveryPhraseFromCertificateRequest.execute(
      {
        passphrase,
        scrambledInput,
      }
    ).promise;

    this.getWalletRecoveryPhraseFromCertificateRequest.reset();

    // $FlowFixMe
    return unscrambledRecoveryPhrase;
  };

  _restore = async () => {
    // Pause polling in order to avoid fetching data for wallet we are about to restore
    // so that we remain on the "Add wallet" screen until user closes the TADA screen
    await this._pausePolling();

    // Reset restore requests to clear previous errors
    this._restoreWalletResetRequests();

    const data = {
      recoveryPhrase: this.mnemonics,
      walletName: this.walletName,
      spendingPassword: this.spendingPassword,
    };

    const request = this.restoreRequest;

    if (
      this.walletKind === WALLET_KINDS.DAEDALUS &&
      this.walletKindDaedalus === WALLET_DAEDALUS_KINDS.BYRON_27_WORD
    ) {
      // Reset getWalletRecoveryPhraseFromCertificateRequest to clear previous errors
      this.getWalletRecoveryPhraseFromCertificateRequest.reset();
      data.recoveryPhrase = await this._getUnscrambledMnemonics(this.mnemonics);
    }

    try {
      const restoredWallet = await request.execute(data).promise;
      if (!restoredWallet)
        throw new Error('Restored wallet was not received correctly');

      runInAction('set restoredWallet', () => {
        this.restoredWallet = restoredWallet;
        this.restoreWalletStep = 3;
      });
    } catch (error) {
      this._resumePolling();
    }
  };

  _sendMoney = async ({
    receiver,
    amount,
    passphrase,
    assets,
    assetsAmounts: assetsAmountsStr,
  }: {
    receiver: string,
    amount: string,
    passphrase: string,
    assets?: Array<WalletSummaryAsset>,
    assetsAmounts?: Array<string>,
  }) => {
    const assetsAmounts = assetsAmountsStr
      ? assetsAmountsStr.map((assetAmount) => parseInt(assetAmount, 10))
      : null;
    const formattedAssets =
      assets && assets.length
        ? assets.map(
            // eslint-disable-next-line
            ({ policyId: policy_id, assetName: asset_name }, index) => ({
              policy_id,
              asset_name,
              quantity: get(assetsAmounts, index, 0),
            })
          )
        : null;

    const wallet = this.active;
    if (!wallet) throw new Error('Active wallet required before sending.');
    await this.sendMoneyRequest.execute({
      address: receiver,
      amount: parseInt(amount, 10),
      passphrase,
      walletId: wallet.id,
      isLegacy: wallet.isLegacy,
      assets: formattedAssets,
    });
    this.refreshWalletsData();
    this.actions.dialogs.closeActiveDialog.trigger();
    this.sendMoneyRequest.reset();
    this.goToWalletRoute(wallet.id);
  };

  @action _transferFundsNextStep = async () => {
    const {
      transferFundsStep,
      transferFundsSourceWalletId,
      transferFundsTargetWalletId,
    } = this;
    let nextStep = 0;
    if (transferFundsStep === 0 && transferFundsSourceWalletId) {
      nextStep = 1;
    }
    if (
      transferFundsStep === 1 &&
      transferFundsSourceWalletId &&
      transferFundsTargetWalletId
    ) {
      await this._transferFundsCalculateFee({
        sourceWalletId: transferFundsSourceWalletId,
      });
      nextStep = 2;
    }
    runInAction('update transfer funds step', () => {
      this.transferFundsStep = nextStep;
    });
  };

  @action _transferFundsPrevStep = () => {
    const { transferFundsStep } = this;
    const prevStep = transferFundsStep > 0 ? transferFundsStep - 1 : 0;
    this.transferFundsStep = prevStep;
  };

  @action _transferFunds = async ({
    spendingPassword,
  }: {
    spendingPassword: string,
  }) => {
    const { transferFundsSourceWalletId, transferFundsTargetWalletId } = this;
    const targetWalletAddresses = await this.getWalletAddressesRequest.execute({
      walletId: transferFundsTargetWalletId,
      queryParams: { state: 'unused' },
    }).promise;
    await this.transferFundsRequest.execute({
      sourceWalletId: transferFundsSourceWalletId,
      targetWalletAddresses: targetWalletAddresses
        ? targetWalletAddresses.map((address) => address.id).slice(0, 20)
        : null,
      passphrase: spendingPassword,
    });

    this.refreshWalletsData();
    this._transferFundsClose();
    this.transferFundsRequest.reset();
    this.goToWalletRoute(transferFundsSourceWalletId);
  };

  @action _transferFundsSetSourceWalletId = ({
    sourceWalletId,
  }: {
    sourceWalletId: string,
  }) => {
    this.transferFundsSourceWalletId = sourceWalletId;
    // Sets the target wallet to the first wallet
    const { allWallets } = this;
    this.transferFundsTargetWalletId = get(allWallets, [0, 'id'], '');
    // Sets to first step
    this.transferFundsStep = 1;
  };

  @action _transferFundsSetTargetWalletId = ({
    targetWalletId,
  }: {
    targetWalletId: string,
  }) => {
    this.transferFundsTargetWalletId = targetWalletId;
  };

  @action _transferFundsRedeem = () => {
    this.transferFundsStep = 0;
    // TODO: Call API method
  };

  @action _transferFundsClose = () => {
    this.transferFundsStep = 0;
    this.transferFundsFee = null;
    this.transferFundsCalculateFeeRequest.reset();
  };

  @action _transferFundsCalculateFee = async ({
    sourceWalletId,
  }: {
    sourceWalletId: string,
  }) => {
    const {
      fee,
      leftovers,
    } = await this.transferFundsCalculateFeeRequest.execute({
      sourceWalletId,
    }).promise;
    runInAction('set migration fee and leftovers', () => {
      this.transferFundsFee = fee;
      this.transferFundsLeftovers = leftovers;
    });
  };

  // =================== PUBLIC API ==================== //

  // GETTERS

  @computed get hasActiveWallet(): boolean {
    return !!this.active;
  }

  @computed get hasLoadedWallets(): boolean {
    return this.walletsRequest.wasExecuted;
  }

  @computed get hasAnyWallets(): boolean {
    if (this.walletsRequest.result == null) return false;
    return (
      this.walletsRequest.wasExecuted && this.walletsRequest.result.length > 0
    );
  }

  @computed get hasRewardsWallets(): boolean {
    return this.allWallets.length > 0;
  }

  @computed get hasMaxWallets(): boolean {
    return this.all.length >= MAX_ADA_WALLETS_COUNT;
  }

  @computed get all(): Array<Wallet> {
    return [...this.allWallets, ...this.allLegacyWallets];
  }

  @computed get allWallets(): Array<Wallet> {
    return this.walletsRequest.result
      ? this.walletsRequest.result.filter(({ isLegacy }: Wallet) => !isLegacy)
      : [];
  }

  @computed get allLegacyWallets(): Array<Wallet> {
    return this.walletsRequest.result
      ? this.walletsRequest.result.filter(({ isLegacy }: Wallet) => isLegacy)
      : [];
  }

  @computed get first(): ?Wallet {
    return this.all.length > 0 ? this.all[0] : null;
  }

  @computed get hasAnyLoaded(): boolean {
    return this.all.length > 0;
  }

  @computed get activeWalletRoute(): ?string {
    if (!this.active) return null;
    return this.getWalletRoute(this.active.id);
  }

  @computed get isWalletRoute(): boolean {
    const { currentRoute } = this.stores.app;
    return matchRoute(`${ROUTES.WALLETS.ROOT}(/*rest)`, currentRoute);
  }

  @computed get restoreRequest(): Request {
    switch (this.walletKind) {
      case WALLET_KINDS.DAEDALUS:
        if (
          this.walletKindDaedalus === WALLET_DAEDALUS_KINDS.SHELLEY_15_WORD ||
          this.walletKindDaedalus === WALLET_DAEDALUS_KINDS.SHELLEY_24_WORD
        ) {
          return this.restoreDaedalusRequest;
        }
        return this.restoreByronRandomWalletRequest;
      case WALLET_KINDS.YOROI:
        if (this.walletKindYoroi === WALLET_YOROI_KINDS.BYRON_15_WORD) {
          return this.restoreByronIcarusWalletRequest;
        }
        return this.restoreDaedalusRequest;
      case WALLET_KINDS.HARDWARE:
        if (this.walletKindHardware === WALLET_HARDWARE_KINDS.LEDGER) {
          return this.restoreByronLedgerWalletRequest;
        }
        return this.restoreByronTrezorWalletRequest;
      default:
        return this.restoreDaedalusRequest;
    }
  }

  @computed get localizedCurrencyList(): Array<LocalizedCurrency> {
    const { currencyList, stores } = this;
    const { currentLocale } = stores.profile;
    return getLocalizedCurrenciesList(currencyList, currentLocale);
  }

  @computed get localizedCurrency(): ?LocalizedCurrency {
    const { currencySelected, stores } = this;
    const { currentLocale } = stores.profile;
    if (!currencySelected) return null;
    return getLocalizedCurrency(currencySelected, currentLocale);
  }

  getWalletById = (id: string): ?Wallet => this.all.find((w) => w.id === id);

  getWalletByName = (name: string): ?Wallet =>
    this.all.find((w) => w.name === name);

  getWalletRoute = (walletId: string, page: string = 'summary'): string =>
    buildRoute(ROUTES.WALLETS.PAGE, { id: walletId, page });

  // ACTIONS

  goToWalletRoute(walletId: string) {
    const route = this.getWalletRoute(walletId);
    this.actions.router.goToRoute.trigger({ route });
  }

  // =================== PRIVATE API ==================== //

  @computed get _canRedirectToWallet(): boolean {
    const { currentRoute } = this.stores.app;
    const isRootRoute = matchRoute(ROUTES.WALLETS.ROOT, currentRoute);
    const isAddWalletRoute = matchRoute(ROUTES.WALLETS.ADD, currentRoute);
    return isRootRoute || isAddWalletRoute;
  }

  _patchWalletRequestWithNewWallet = async (wallet: Wallet) => {
    // Only add the new wallet if it does not exist yet in the result!
    await this.walletsRequest.patch((result) => {
      if (!find(result, { id: wallet.id })) {
        if (wallet.isLegacy) {
          // Legacy wallets are always added to the end of the list!
          result.push(wallet);
        } else {
          const index = findIndex(result, 'isLegacy');
          if (index >= 0) {
            result.splice(index, 0, wallet);
          } else {
            result.push(wallet);
          }
        }
      }
    });
  };

  _pollRefresh = async () => {
    const { isConnected } = this.stores.networkStatus;
    return isConnected && this.refreshWalletsData();
  };

  _updateActiveWalletOnRouteChanges = () => {
    const { currentRoute } = this.stores.app;
    const hasAnyWalletLoaded = this.hasAnyLoaded;
    const isWalletAddPage = matchRoute(ROUTES.WALLETS.ADD, currentRoute);
    runInAction('WalletsStore::_updateActiveWalletOnRouteChanges', () => {
      // There are not wallets loaded (yet) -> unset active and return
      if (isWalletAddPage || !hasAnyWalletLoaded)
        return this._unsetActiveWallet();
      const match = matchRoute(
        `${ROUTES.WALLETS.ROOT}/:id(*page)`,
        currentRoute
      );
      if (match) {
        // We have a route for a specific wallet -> let's try to find it
        const walletForCurrentRoute = this.all.find((w) => w.id === match.id);
        if (walletForCurrentRoute) {
          // The wallet exists, we are done
          this._setActiveWallet({ walletId: walletForCurrentRoute.id });
        } else if (hasAnyWalletLoaded) {
          // There is no wallet with given id -> pick first wallet
          this._setActiveWallet({ walletId: this.all[0].id });
          if (this.active) this.goToWalletRoute(this.active.id);
        }
      } else if (this._canRedirectToWallet) {
        // The route does not specify any wallet -> pick first wallet
        if (!this.hasActiveWallet && hasAnyWalletLoaded) {
          this._setActiveWallet({ walletId: this.all[0].id });
        }
        if (this.active) {
          this.goToWalletRoute(this.active.id);
        }
      }
    });
  };

  isValidAddress = async (address: string) => {
    const { isIncentivizedTestnet, isShelleyTestnet } = global;
    const { isMainnet, isSelfnode, isStaging, isTestnet } = this.environment;
    let expectedNetworkTag: ?Array<?number> | ?number;
    let validAddressStyles: AddressStyle[] = ['Byron', 'Icarus', 'Shelley'];
    this.isAddressFromSameWallet = false;

    if (isMainnet) {
      expectedNetworkTag = MAINNET_MAGIC;
    } else if (isStaging) {
      expectedNetworkTag = STAGING_MAGIC;
    } else if (isIncentivizedTestnet) {
      expectedNetworkTag = ITN_MAGIC;
      validAddressStyles = ['Jormungandr'];
    } else if (isTestnet) {
      expectedNetworkTag = TESTNET_MAGIC;
    } else if (isShelleyTestnet) {
      expectedNetworkTag = SHELLEY_TESTNET_NETWORK_ID;
    } else if (isSelfnode) {
      expectedNetworkTag = SELFNODE_MAGIC;
    } else {
      throw new Error('Unexpected environment');
    }
    try {
      const response = await introspectAddressChannel.send({ input: address });
      if (response === 'Invalid') {
        return false;
      }
      runInAction('check if address is from the same wallet', () => {
        const walletAddresses = this.stores.addresses.all
          .slice()
          .map((addr) => addr.id);
        this.isAddressFromSameWallet = !!walletAddresses.filter(
          (addr) => addr === address
        ).length;
      });
      return (
        validAddressStyles.includes(response.introspection.address_style) &&
        ((Array.isArray(expectedNetworkTag) &&
          includes(expectedNetworkTag, response.introspection.network_tag)) ||
          expectedNetworkTag === response.introspection.network_tag)
      );
    } catch (error) {
      logger.error(error);
    }
  };

  isValidCertificateMnemonic = (mnemonic: string) =>
    this.api.ada.isValidCertificateMnemonic(mnemonic);

  @action refreshWalletsData = async () => {
    // Prevent wallets data refresh if polling is blocked
    if (this._pollingBlocked) return;

    if (this.stores.networkStatus.isConnected) {
      const result = await this.walletsRequest.execute().promise;
      if (!result) return;
      const walletIds = result
        .filter(
          ({ syncState }: Wallet) =>
            syncState.status !== WalletSyncStateStatuses.NOT_RESPONDING
        )
        .map((wallet: Wallet) => wallet.id);

      await this.actions.walletsLocal.refreshWalletsLocalData.trigger();

      runInAction('refresh active wallet', () => {
        if (this.active) {
          this._setActiveWallet({ walletId: this.active.id });
        }
      });
      runInAction('refresh address data', () => {
        this.stores.addresses.addressesRequests = walletIds.map((walletId) => ({
          walletId,
          allRequest: this.stores.addresses._getAddressesAllRequest(walletId),
        }));
        this.stores.addresses._refreshAddresses();
      });
      runInAction('refresh transaction data', () => {
        this.stores.transactions.transactionsRequests = walletIds.map(
          (walletId) => ({
            walletId,
            recentRequest: this.stores.transactions._getTransactionsRecentRequest(
              walletId
            ),
            allRequest: this.stores.transactions._getTransactionsAllRequest(
              walletId
            ),
            withdrawalsRequest: this.stores.transactions._getWithdrawalsRequest(
              walletId
            ),
          })
        );
        this.stores.transactions._refreshTransactionData();
      });
      this.actions.wallets.refreshWalletsDataSuccess.trigger();
    }
  };

  @action resetWalletsData = () => {
    this.walletsRequest.reset();
    this.stores.addresses.addressesRequests = [];
    this.stores.transactions.transactionsRequests = [];
    this.isAddressFromSameWallet = false;
  };

  @action _importWalletFromFile = async (
    params: WalletImportFromFileParams
  ) => {
    const { filePath, walletName, spendingPassword } = params;
    const importedWallet = await this.importFromFileRequest.execute({
      filePath,
      walletName,
      spendingPassword,
    }).promise;
    if (!importedWallet)
      throw new Error('Imported wallet was not received correctly');
    await this._patchWalletRequestWithNewWallet(importedWallet);
    this.actions.dialogs.closeActiveDialog.trigger();
    this.importFromFileRequest.reset();
    this.goToWalletRoute(importedWallet.id);
    this.refreshWalletsData();
  };

  @action _setActiveWallet = ({ walletId }: { walletId: string }) => {
    if (this.hasAnyWallets) {
      const activeWalletId = this.active ? this.active.id : null;
      const newActiveWallet = this.all.find((wallet) => wallet.id === walletId);
      if (
        (!this.active || !this.active.isNotResponding) &&
        newActiveWallet &&
        newActiveWallet.isNotResponding
      ) {
        this.actions.router.goToRoute.trigger({
          route: ROUTES.WALLETS.PAGE,
          params: { id: newActiveWallet.id, page: 'summary' },
        });
      }
      const hasActiveWalletBeenChanged = activeWalletId !== walletId;
      const hasActiveWalletBeenUpdated = !isEqual(this.active, newActiveWallet);
      if (hasActiveWalletBeenChanged) {
        // Active wallet has been replaced or removed
        this.active = newActiveWallet || null;
        this.stores.addresses.lastGeneratedAddress = null;
        if (this.active) {
          this.activeValue = formattedWalletAmount(this.active.amount);
          if (this.active && this.active.isHardwareWallet) {
            const {
              hardwareWalletsConnectionData,
            } = this.stores.hardwareWallets;
            const hardwareWalletConnectionData = get(
              hardwareWalletsConnectionData,
              this.active.id
            );
            if (hardwareWalletConnectionData) {
              const { extendedPublicKey } = hardwareWalletConnectionData;
              const extendedPublicKeyHex = `${extendedPublicKey.publicKeyHex}${extendedPublicKey.chainCodeHex}`;
              const xpub = Buffer.from(extendedPublicKeyHex, 'hex');
              const activePublicKey = bech32EncodePublicKey(xpub);
              this.activePublicKey = activePublicKey || null;
            }
          } else {
            this.activePublicKey = null;
          }
        }
      } else if (hasActiveWalletBeenUpdated) {
        // Active wallet has been updated
        if (this.active && newActiveWallet) this.active.update(newActiveWallet);
      }
    }
  };

  @action _unsetActiveWallet = () => {
    this.active = null;
    this.activeValue = null;
    this.activePublicKey = null;
    this.stores.addresses.lastGeneratedAddress = null;
  };

  @action _onRouteChange = (options: { route: string, params: ?Object }) => {
    // Reset the send request anytime we visit the send page (e.g: to remove any previous errors)
    if (
      matchRoute(ROUTES.WALLETS.SEND, buildRoute(options.route, options.params))
    ) {
      this.sendMoneyRequest.reset();
      this.isAddressFromSameWallet = false;
    }
  };

  @action _chooseWalletExportType = (params: {
    walletExportType: WalletExportTypeChoices,
  }) => {
    if (this.walletExportType !== params.walletExportType) {
      this.walletExportType = params.walletExportType;
    }
  };

  @action _pausePolling = async () => {
    if (this.walletsRequest.isExecuting) await this.walletsRequest;
    runInAction('AdaWalletsStore::_pausePolling', () => {
      this._pollingBlocked = true;
    });
  };

  @action _resumePolling = () => {
    this._pollingBlocked = false;
  };

  /**
   * Generates a paper wallet certificate by creating a temporary wallet
   * and extracting its data before deleting it. Saves the certificate
   * as PDF to the user selected file location.
   *
   * Using mobx flows: https://mobx.js.org/best/actions.html#flows
   * @private
   */
  _generateCertificate = flow(function* generateCertificate(params: {
    filePath: string,
    timestamp: string,
  }): Generator<any, any, any> {
    try {
      // Pause polling in order not to show Paper wallet in the UI
      yield this._pausePolling();

      // Set inProgress state to show spinner if is needed
      this._updateCertificateCreationState(true);

      // Generate wallet recovery phrase
      const recoveryPhrase: Array<string> = yield this.getWalletRecoveryPhraseRequest.execute()
        .promise;

      // Generate 9-words (additional) mnemonic
      const additionalMnemonicWords: Array<string> = yield this.getWalletCertificateAdditionalMnemonicsRequest.execute()
        .promise;
      this.additionalMnemonicWords = additionalMnemonicWords.join(' ');

      // Generate spending password from 9-word mnemonic and save to store
      const spendingPassword = mnemonicToSeedHex(this.additionalMnemonicWords);
      this.walletCertificatePassword = spendingPassword;

      // Generate paper wallet scrambled mnemonic
      const walletCertificateRecoveryPhrase: Array<string> = yield this.getWalletCertificateRecoveryPhraseRequest.execute(
        {
          passphrase: spendingPassword,
          input: recoveryPhrase.join(' '),
        }
      ).promise;
      this.walletCertificateRecoveryPhrase = walletCertificateRecoveryPhrase.join(
        ' '
      );

      // Create temporary wallet
      const walletData = {
        name: 'Paper Wallet',
        mnemonic: recoveryPhrase.join(' '),
      };
      const wallet = yield this.createWalletRequest.execute(walletData).promise;

      // Get temporary wallet address
      let walletAddresses;
      if (wallet) {
        walletAddresses = yield this.getWalletAddressesRequest.execute({
          walletId: wallet.id,
        }).promise;

        // delete temporary wallet
        yield this.deleteWalletRequest.execute({
          walletId: wallet.id,
          isLegacy: wallet.isLegacy,
        });
      }

      // Set wallet certificate address
      const walletAddress = get(walletAddresses, ['0', 'id'], null);
      this.walletCertificateAddress = walletAddress;

      // download pdf certificate
      yield this._downloadCertificate(
        walletAddress,
        walletCertificateRecoveryPhrase,
        params.filePath,
        params.timestamp
      );
    } catch (error) {
      throw error;
    } finally {
      this._resumePolling();
    }
  }).bind(this);

  _downloadCertificate = async (
    address: string,
    recoveryPhrase: Array<string>,
    filePath: string,
    timestamp: string
  ) => {
    const locale = this.stores.profile.currentLocale;
    const intl = i18nContext(locale);
    const { isMainnet } = this.environment;
    const { buildLabel } = global;
    try {
      await paperWalletPdfGenerator({
        address,
        mnemonics: recoveryPhrase,
        intl,
        filePath,
        isMainnet,
        buildLabel,
        timestamp,
      });
      runInAction('handle successful certificate download', () => {
        // Reset progress
        this._updateCertificateCreationState(false);
        // Update certificate generator step
        this._updateCertificateStep();
      });
    } catch (error) {
      runInAction('handle failed certificate download', () => {
        // Reset progress
        this._updateCertificateCreationState(false, error);
      });
    }
  };

  _generateAddressPDF = async ({
    note,
    address,
    filePath,
  }: {
    note: string,
    address: string,
    filePath: string,
  }) => {
    const {
      currentLocale,
      currentDateFormat,
      currentTimeFormat,
    } = this.stores.profile;
    const { network, isMainnet } = this.environment;
    const intl = i18nContext(currentLocale);
    try {
      await addressPDFGenerator({
        address,
        note,
        filePath,
        currentLocale,
        currentDateFormat,
        currentTimeFormat,
        network,
        isMainnet,
        intl,
      });
      const walletAddress = ellipsis(address, 15, 15);
      this.actions.wallets.generateAddressPDFSuccess.trigger({ walletAddress });
    } catch (error) {
      throw new Error(error);
    }
  };

  _saveQRCodeImage = async ({
    address,
    filePath,
  }: {
    address: string,
    filePath: string,
  }) => {
    try {
      await saveQRCodeImageChannel.send({
        address,
        filePath,
      });
      const walletAddress = ellipsis(address, 15, 15);
      this.actions.wallets.saveQRCodeImageSuccess.trigger({ walletAddress });
    } catch (error) {
      throw new Error(error);
    }
  };

  _updateCertificateCreationState = action(
    (state: boolean, error?: ?Object) => {
      this.generatingCertificateInProgress = state;
      this._updateGeneratingCertificateError(error);
    }
  );

  _updateGeneratingCertificateError = action((error?: ?Object) => {
    if (error && error.syscall && error.syscall === 'open') {
      // User tries to replace a file that is open
      this.generatingCertificateError = new WalletPaperWalletOpenPdfError();
    } else {
      this.generatingCertificateError = null;
    }
  });

  /**
   * Generates a rewards csv and saves it to the user selected file location.
   *
   * Using mobx flows: https://mobx.js.org/best/actions.html#flows
   * @private
   */
  _generateCsv = flow(function* generateCsv({
    fileContent,
    filePath,
  }: {
    fileContent: CsvFileContent,
    filePath: string,
  }) {
    try {
      yield this._pausePolling();

      // Set inProgress state to show spinner if is needed
      this._updateRewardsCsvCreationState(true);

      // download rewards csv
      yield this._downloadRewardsCsv(fileContent, filePath);
    } catch (error) {
      throw error;
    } finally {
      this._resumePolling();
    }
  }).bind(this);

  _downloadRewardsCsv = async (
    fileContent: CsvFileContent,
    filePath: string
  ) => {
    try {
      await downloadCsv({
        fileContent,
        filePath,
      });
      runInAction('handle successful rewards csv download', () => {
        this._updateRewardsCsvCreationState(false);
      });
    } catch (error) {
      runInAction('handle failed rewards csv download', () => {
        this._updateRewardsCsvCreationState(false, error);
      });
    }
  };

  _updateRewardsCsvCreationState = action((state: boolean, error?: ?Object) => {
    this.generatingRewardsCsvInProgress = state;
    this._updateGeneratingRewardsCsvError(error);
  });

  _updateGeneratingRewardsCsvError = action((error?: ?Object) => {
    if (error && error.syscall && error.syscall === 'open') {
      // User tries to replace a file that is open
      this.generatingRewardsCsvError = new WalletRewardsOpenCsvError();
    } else {
      this.generatingRewardsCsvError = null;
    }
  });

  @action _setCertificateTemplate = (params: { selectedTemplate: string }) => {
    this.certificateTemplate = params.selectedTemplate;
    this._updateCertificateStep();
  };

  @action _finishCertificate = () => {
    this._updateGeneratingCertificateError();
    this._closeCertificateGeneration();
  };

  @action _finishRewardsCsv = () => {
    this._updateGeneratingRewardsCsvError();
    this._closeRewardsCsvGeneration();
  };

  @action _updateCertificateStep = (isBack: boolean = false) => {
    this._updateGeneratingCertificateError();
    const currrentCertificateStep = this.certificateStep || 0;
    this.certificateStep = isBack
      ? currrentCertificateStep - 1
      : currrentCertificateStep + 1;
  };

  @action _closeCertificateGeneration = () => {
    this.actions.dialogs.closeActiveDialog.trigger();
    this._resetCertificateData();
  };

  @action _closeRewardsCsvGeneration = () => {
    this.actions.dialogs.closeActiveDialog.trigger();
    this._resetRewardsCsvData();
  };

  @action _resetCertificateData = () => {
    this.walletCertificatePassword = null;
    this.walletCertificateAddress = null;
    this.walletCertificateRecoveryPhrase = null;
    this.generatingCertificateInProgress = false;
    this.certificateTemplate = false;
    this.certificateStep = null;
    this._updateGeneratingCertificateError();
  };

  @action _resetRewardsCsvData = () => {
    this.generatingRewardsCsvInProgress = false;
    this._updateGeneratingRewardsCsvError();
  };
}
