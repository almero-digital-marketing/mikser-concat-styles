'use strict'
let Promise = require('bluebird');
let path = require('path');
let fs = require('fs-extra-promise');
let postcss = require('postcss');
let atImport = require('postcss-import');
let url = require('postcss-url');
let _ = require('lodash');
let touch = require('touch');

module.exports = function (mikser, context) {
	if (!context) {

		let debug = mikser.debug('concat-styles');
		let map = {};
		let runtimeMap = path.join(mikser.config.runtimeFolder, 'concat-styles.json');
		if (fs.existsSync(runtimeMap)) {
			map = JSON.parse(fs.readFileSync(runtimeMap, 'utf-8'));
		}

		mikser.on('mikser.watcher.outputAction', (event, file) => {
			file = path.join(mikser.config.outputFolder, file);
			let destinationsToRealod = _.keys(_.pickBy(map, (destination) => {
				return destination.sources.indexOf(file) !== -1;
			}));

			if (event == 'change' || event == 'unlink') {
				if (destinationsToRealod.length) {
					debug('Concatenating:', destinationsToRealod, file);
					return Promise.map(destinationsToRealod, (destination) => {
						if (event == 'unlink') Array.prototype.splice.call(map[destination].sources, map[destination].sources.indexOf(file), 1);
						return concat(map[destination]);
					}).then(() => {
						debug('Concatenating finished');
					});
				} else {
					return Promise.resolve();
				}
			}
			return Promise.resolve();
		});

		function rebase (style, info) {
			debug('Rebase: started:', style);
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
						return Promise.resolve(result.css);
					});
			});
		}

		function concat (info) {
			map[info.destination] = {
				sources: info.sources,
				sourcemap: info.sourcemap === true ? info.sourcemap : false,
				destination: info.destination
			}
			fs.writeFileSync(runtimeMap, JSON.stringify(map, null, 2));

			if (mikser.manager.isNewer(info.sources, info.destination)) {
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
					return fs.outputFileAsync(info.destination, output.css).then(() => debug('Concat done:', info.destination));
				});
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

			context.pending = context.pending.then(() => {
				return mikser.broker.call('mikser.plugins.concatStyles.concat', concatInfo).then((message) => {
					if (message) console.log(message);
					return Promise.resolve();
				}).catch((err) => {
					console.log(err, 'in catch');
					return Promise.resolve();
				})
			});
			return mikser.manager.getUrl(concatInfo.destination);
		}

	}
}