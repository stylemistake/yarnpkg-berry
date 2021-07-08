import { Descriptor, FetchResult, Installer, LinkOptions, LinkType, Locator, Package, structUtils } from '@yarnpkg/core';
import { FinalizeInstallData } from '@yarnpkg/core/sources/Installer';
import { Filename, PortablePath, ppath, xfs } from '@yarnpkg/fslib';
import { UsageError } from 'clipanion';
import { getIncludePath, getPathmapPath, getVendoredPackagePath, getVendorPath } from './paths';

export class DmInstaller implements Installer {
  private enabled: boolean;
  private dependencies: Map<string, {
    packageLocator: Locator,
    packageLocation: PortablePath,
    packageDependencies: Set<string>,
  }> = new Map();

  constructor(protected opts: LinkOptions) {
    this.enabled = opts.project.configuration.get('dmLinker');
  }

  async installPackage(pkg: Package, fetchResult: FetchResult) {
    if (!this.enabled) {
      throw new UsageError(`Installing DM packages requires "dmLinker: true" in .yarnrc.yml`);
    }
    const isWorkspace = Boolean(this.opts.project.tryWorkspaceByLocator(pkg));
    const isHardLink = pkg.linkType === LinkType.HARD && !isWorkspace;
    const isVirtual = structUtils.isVirtualLocator(pkg);

    const vendorLocation = getVendoredPackagePath(this.opts.project, pkg);

    if (isHardLink) {
      await xfs.mkdirPromise(vendorLocation, { recursive: true });
      await xfs.copyPromise(vendorLocation, fetchResult.prefixPath, {
        baseFs: fetchResult.packageFs,
        overwrite: false,
      });
    }

    const packageLocation = isHardLink
      ? vendorLocation
      : ppath.resolve(
        fetchResult.packageFs.getRealPath(),
        fetchResult.prefixPath
      );

    this.dependencies.set(pkg.locatorHash, {
      packageLocator: pkg,
      packageLocation,
      packageDependencies: new Set(),
    });

    return {
      packageLocation,
      buildDirective: null,
    };
  }

  getCustomDataKey() {
    return JSON.stringify({
      name: 'DmInstaller',
      version: 1,
    });;
  }

  async attachCustomData(customData: any) {}

  async attachInternalDependencies(
    locator: Locator,
    dependencies: [Descriptor, Locator][],
  ) {
    const entry = this.dependencies.get(locator.locatorHash);
    if (typeof entry === `undefined`) {
      throw new Error(`Assertion failed: Expected locator to be registered (${structUtils.prettyLocator(this.opts.project.configuration, locator)})`);
    }
    for (const [, dependency] of dependencies) {
      entry.packageDependencies.add(dependency.locatorHash);
    }
  }

  async attachExternalDependents(
    locator: Locator,
    dependentPaths: PortablePath[],
  ) {}

  async finalizeInstall(): Promise<FinalizeInstallData> {
    if (!this.enabled) {
      xfs.removeSync(getVendorPath(this.opts.project), {
        recursive: true,
      });
      return {};
    }
    await this.writeIncludes();
    await this.writePathMap();
    return {};
  }

  private async writePathMap() {
    const data: {[key: string]: string} = {};
    for (const [locatorStr, { packageLocation }] of this.dependencies) {
      data[locatorStr] = ppath.relative(
        this.opts.project.cwd,
        packageLocation
      );
    }
    const pathmapFile = getPathmapPath(this.opts.project);
    await xfs.writeFilePromise(
      pathmapFile,
      `${JSON.stringify(data, null, 2)}\n`
    );
  }

  private async writeIncludes() {
    const includePath = getIncludePath(this.opts.project);
    const includeDirName = ppath.dirname(includePath);
    const includeList = [];
    for (const { packageLocation } of this.dependencies.values()) {
      const packageIncludePath = ppath.join(
        packageLocation,
        'includes.dm' as Filename
      );
      if (!xfs.existsSync(packageIncludePath)) {
        continue;
      }
      includeList.push(ppath.relative(
        includeDirName,
        packageIncludePath
      ));
    }
    let content = ``;
    content += `/*!\n`;
    content += ` * This file is auto generated by DM installer (do not edit).\n`;
    content += ` */\n`;
    content += `\n`;
    for (const path of includeList) {
      content += `#include "${path}"\n`;
    }
    content == `\n`;
    await xfs.mkdirPromise(includeDirName, { recursive: true });
    await xfs.writeFilePromise(includePath, content);
  }
}
