'use strict'
let Promise = require('bluebird');
let path = require('path');
let fs = require('fs-extra-promise');
let postcss = require('postcss');
let atImport = require('postcss-import');
let url = require('postcss-url');
let _ = require('lodash');
let touch = require('touch');
let cluster = require('cluster');

module.exports = function (mikser, context) {
	let debug = mikser.debug('concat-styles');

	if (!context) {

		let rebaseCache = {};
		let map = {};
		let runtimeMap = path.join(mikser.config.runtimeFolder, 'concat-styles.json');
		if (fs.existsSync(runtimeMap)) {
			map = JSON.parse(fs.readFileSync(runtimeMap, 'utf-8'));
		}

		mikser.on('mikser.watcher.outputAction', (event, file) => {
			if (map[file]) return;
			file = path.join(mikser.config.outputFolder, file);
			let destinationsToRealod = _.keys(_.pickBy(map, (destination) => {
				return destination.sources.indexOf(file) !== -1;
			}));

			if (event == 'change' || event == 'unlink') {
				if (destinationsToRealod.length) {
					debug('Concatenating:', file, '->', destinationsToRealod.join(','));
					return Promise.map(destinationsToRealod, (destination) => {
						if (event == 'unlink') Array.prototype.splice.call(map[destination].sources, map[destination].sources.indexOf(file), 1);
						return concat(map[destination]);
					}, {
						concurrency: 1
					}).then(() => {
						debug('Concatenating finished');
						return fs.writeFileAsync(runtimeMap, JSON.stringify(map, null, 2));
					});
				} else {
					return Promise.resolve();
				}
			}
			return Promise.resolve();
		});

		function rebase(style, info) {
			debug('Rebase started:', style);
			return fs.statAsync(style).then((stats) => {
				if (rebaseCache[style] && stats.mtime.getTime() <= rebaseCache[style].mtime) {
					return Promise.resolve(rebaseCache[style].css);
				}
				return fs.readFileAsync(style).then((content) => {
					return postcss()
						.use(url({
							url: "rebase"
						}))
						.process(content, {
							from: mikser.manager.getUrl(style),
							to: mikser.manager.getUrl(info.destination)
						}).then((result) => {
							debug('Rebase done:', style);
							rebaseCache[style] = {
								mtime: stats.mtime.getTime(),
								css: result.css
							}
							return Promise.resolve(result.css);
						});
				});
			});
		}

		function concat(info) {
			map[info.destination] = {
				sources: info.sources,
				sourcemap: info.sourcemap === true ? info.sourcemap : false,
				destination: info.destination
			}

			if (mikser.manager.isNewer(info.sources, info.destination)) {
				return mikser.watcher.unplug().then(() => {
					// Lock inline file for further usage by creating it and updating its mtime;
					fs.ensureFileSync(info.destination);
					touch.sync(info.destination);
					let importContent = '';
					info.sources.forEach((style, index) => {
						importContent += '@import "' + style + (index === info.sources.length -1 ? '";' : '";\n');
					});
					debug('Concat started: ', info.destination);
					return postcss(atImport({
						root: mikser.config.outputFolder,
						load: (fileName) => {
							return rebase(fileName, info);
						}
					}))
					.process(importContent, {
						from: mikser.config.outputFolder,
						to: info.destination,
						map: info.sourcemap === true ? { inline: true } : false
					}).then((output) => {
						return fs.outputFileAsync(info.destination, output.css).then(debug('Concat done:', info.destination));
					});
				}).then(() => mikser.watcher.plug());					
			} else {
				debug('Destination is up to date: ', info.destination);
				return Promise.resolve();
			}
		}
		return Promise.resolve({concat: concat});

	} else {

		context.concatStyles = function (sources, destination, sourcemap) {
			if (!sources) {
				let err = new Error('Undefined source list');
				err.origin = 'concat';
				throw err;
			}

			if (!Array.isArray(sources)) sources = [sources];
			let share = mikser.manager.getShare(context.document.destination);
			sources.forEach((source, index, arr) => {
				if (share){
					arr[index] = path.join(mikser.config.outputFolder, share, source);
				}
				else {
					arr[index] = path.join(mikser.config.outputFolder, source);
				}
			});

			if (!destination) {
				let err = new Error('Undefined destination');
				err.origin = 'concat';
				throw err;
			}

			let concatInfo = {
				sources: sources,
				sourceExt: '.css',
				destinationExt: path.extname(destination),
				sourcemap: sourcemap === true ? sourcemap : false,
			}
			concatInfo.destination = concatInfo.sourceExt === concatInfo.destinationExt ? path.join(mikser.config.outputFolder, destination) : path.join(mikser.config.outputFolder, destination, path.basename(context.layouts[0]._id, path.extname(context.layouts[0]._id)) + '.all' + concatInfo.sourceExt);

			if (mikser.manager.isNewer(concatInfo.sources, concatInfo.destination)) {
				context.process(() => {
					let concat;
					if (cluster.isMaster) {
						concat = mikser.plugins.concatStyles.concat(concatInfo);
					} else {
						concat = mikser.broker.call('mikser.plugins.concatStyles.concat', concatInfo);
					}
					return concat.then(() => {
						return fs.writeFileAsync(runtimeMap, JSON.stringify(map, null, 2));
					}).catch((err) => {
						mikser.diagnostics.log(context, 'error', 'Error concatenating:', concatInfo.destination, err);
					});
				});
			}
			return mikser.manager.getUrl(concatInfo.destination);
		}

	}
}